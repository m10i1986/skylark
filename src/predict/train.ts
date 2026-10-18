//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { buildRaceSamples } from "./dataset.ts";
import {
    combineEvaluations,
    evaluateRaces,
    type PeriodMetrics,
    toPeriodMetrics,
    type WinPayouts,
} from "./evaluation.ts";
import { fitModel, type ModelParameters } from "./model.ts";
import type { Circuit, RaceRecord, RaceSample } from "./types.ts";
import type { ValueCriteria } from "./value.ts";

const MS_PER_DAY = 86_400_000;
// 学習に必要な最低限のレース数 これ未満では係数が定まらない
const MIN_TRAIN_RACES = 200;

/** 学習・評価の設定 */
export type TrainOptions = {
    circuit: Circuit;
    criteria: ValueCriteria;
    // 履歴の蓄積だけに使う助走期間(日) 最古のレースからこの日数は学習に使わない(出走履歴が欠けているため)
    burnInDays: number;
    // データの最終日から数えたテスト期間の日数 L2の選択にも学習にも使わない 評価だけに使う
    testDays: number;
    // 開発期間のウォークフォワード評価の 1区間の日数と区間の数 テスト期間の直前から遡って並べる
    // 各区間は その区間より前の全期間で学習したモデルで評価する L2の選択と 開発期間の成績に使う
    blockDays: number;
    blockCount: number;
    // 試すL2正則化の強さ 開発期間の対数損失(全区間の平均)が最小のものを使う
    l2Candidates: readonly number[];
};

/** 既定の学習・評価の設定を作る */
export function defaultTrainOptions(criteria: ValueCriteria): TrainOptions {
    return {
        circuit: "jra",
        criteria,
        burnInDays: 90,
        testDays: 100,
        blockDays: 61,
        blockCount: 5,
        l2Candidates: [100, 300, 1000, 3000],
    };
}

/** 期間の区切り すべて開催日(YYYY-MM-DD) */
export type TrainingSplit = {
    // 履歴を蓄積し始めた日(最古のレース)
    historyFrom: string;
    // 学習期間の開始日(助走期間の後)
    trainFrom: string;
    // 開発期間(ウォークフォワードの最初の区間)の開始日 この日より前だけで最初の区間のモデルを学習する
    validFrom: string;
    // テスト期間の開始日(学習にも選択にも使わない)
    testFrom: string;
    // サンプルの最終日
    dataTo: string;
};

/** 学習の結果 */
export type TrainingResult = {
    // 保存するモデル テスト期間も含む全期間で学習し直したもの
    parameters: ModelParameters;
    split: TrainingSplit;
    selectedL2: number;
    // 候補ごとの 開発期間(全区間)の対数損失の平均
    l2Candidates: Array<{ l2: number; devLogLoss: number }>;
    races: {
        // 最初の区間を評価するモデルの学習に使ったレース数
        train: number;
        // 開発期間の評価に使ったレース数
        dev: number;
        test: number;
        // 保存するモデルの学習に使ったレース数
        all: number;
    };
    // 開発期間全体の成績 区間ごとに その区間より前で学習したモデルで評価した結果を合わせたもの
    dev: PeriodMetrics;
    // 開発期間の区間ごとの成績(古い順)
    devBlocks: PeriodMetrics[];
    // テスト期間の成績 開発期間のレースだけで学習したモデルで測る(保存するモデルではない)
    test: PeriodMetrics;
    criteria: ValueCriteria;
};

/** 学習できるだけのデータが無いことを表す */
export class InsufficientDataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InsufficientDataError";
    }
}

/**
 * 日付(YYYY-MM-DD)に日数を足す
 *
 * @param date - 日付
 * @param days - 足す日数 負の値で遡る
 * @returns 日付(YYYY-MM-DD)
 */
export function addDays(date: string, days: number): string {
    return new Date(Date.parse(date) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

function samplesBetween(samples: readonly RaceSample[], fromInclusive: string, toExclusive: string | null) {
    return samples.filter(
        (sample) => sample.date >= fromInclusive && (toExclusive == null || sample.date < toExclusive),
    );
}

/** ウォークフォワードの1区間 toExclusive は次の区間の開始日 */
export type WalkForwardBlock = { from: string; toExclusive: string };

/**
 * テスト期間の直前から遡って 同じ長さの区間を連続して並べる
 *
 * @param testFrom - テスト期間の開始日(最後の区間はこの日の前日まで)
 * @param blockDays - 1区間の日数
 * @param blockCount - 区間の数
 * @returns 古い順の区間
 */
export function walkForwardBlocks(testFrom: string, blockDays: number, blockCount: number): WalkForwardBlock[] {
    return Array.from({ length: blockCount }, (_, index) => {
        const stepsBack = blockCount - index;
        return {
            from: addDays(testFrom, -stepsBack * blockDays),
            toExclusive: addDays(testFrom, -(stepsBack - 1) * blockDays),
        };
    });
}

/**
 * 過去のレースからモデルを学習し 開発期間とテスト期間で評価する
 *
 * 手順
 *  1. 開発期間を数個の区間に分け 各区間をその区間より前の全期間で学習したモデルで評価する(ウォークフォワード)
 *     各L2について 全区間の対数損失の平均を求め 最小のL2を選ぶ(1つの検証期間だけで選ぶより ぶれにくい)
 *  2. 選んだL2で 開発期間のレースだけを使って学習し 一度も使っていないテスト期間で成績を測る
 *  3. 保存するモデルは 選んだL2で テスト期間も含む全期間を使って学習し直す(最新のレースを捨てない)
 *     この3の再学習したモデルは測っていない 2のモデルと同じ手順で学習したものであるため 成績は2で代表する
 *
 * @param races - 結果が確定した全レース(順不同でよい)
 * @param payouts - 単勝の払戻
 * @param options - 学習・評価の設定
 * @returns 学習済みモデルと評価
 * @throws {InsufficientDataError} 学習・評価のいずれかのレースが足りない場合
 */
export function trainPredictionModel(
    races: readonly RaceRecord[],
    payouts: WinPayouts,
    options: TrainOptions,
): TrainingResult {
    if (races.length === 0) {
        throw new InsufficientDataError("no races to train on");
    }
    if (options.l2Candidates.length === 0) {
        throw new RangeError("l2Candidates must not be empty");
    }
    const historyFrom = races.reduce(
        (earliest, race) => (race.date < earliest ? race.date : earliest),
        races[0]?.date ?? "",
    );
    const trainFrom = addDays(historyFrom, options.burnInDays);
    const { samples } = buildRaceSamples(races, { sampleFrom: trainFrom, circuit: options.circuit });
    const dataTo = samples.at(-1)?.date;
    if (dataTo == null) {
        throw new InsufficientDataError("no race has odds and a winner after the burn-in period");
    }

    const testFrom = addDays(dataTo, -(options.testDays - 1));
    const test = samplesBetween(samples, testFrom, null);
    const development = samplesBetween(samples, trainFrom, testFrom);

    // 学習に使えるレースが足りない区間(古い区間)と レースが無い区間は使わない
    const blocks = walkForwardBlocks(testFrom, options.blockDays, options.blockCount)
        .map((block) => ({
            ...block,
            train: samplesBetween(samples, trainFrom, block.from),
            evaluation: samplesBetween(samples, block.from, block.toExclusive),
        }))
        .filter((block) => block.train.length >= MIN_TRAIN_RACES && block.evaluation.length > 0);
    const firstBlock = blocks[0];
    const lastBlock = blocks.at(-1);
    if (firstBlock == null || lastBlock == null || test.length === 0) {
        throw new InsufficientDataError(
            `not enough races: development=${development.length} (each of the ${options.blockCount} blocks needs ${MIN_TRAIN_RACES} races before it), test=${test.length}`,
        );
    }

    // L2ごとに 全区間の評価を集める
    const byL2 = options.l2Candidates.map((l2) => {
        const parts = blocks.map((block) =>
            evaluateRaces(block.evaluation, fitModel(block.train, { l2 }), options.criteria, payouts),
        );
        const pooled = combineEvaluations(parts);
        return { l2, parts, pooled, devLogLoss: pooled.logLossTotals.model / pooled.races };
    });
    const selected = byL2.reduce((best, candidate) => (candidate.devLogLoss < best.devLogLoss ? candidate : best));

    const rangeOf = (block: { from: string; toExclusive: string }) => ({
        from: block.from,
        to: addDays(block.toExclusive, -1),
    });
    const devBlocks = blocks.flatMap((block, index) => {
        const part = selected.parts[index];
        return part == null ? [] : [toPeriodMetrics(part, rangeOf(block))];
    });
    const dev = toPeriodMetrics(selected.pooled, { from: firstBlock.from, to: rangeOf(lastBlock).to });

    const evaluationModel = fitModel(development, { l2: selected.l2 });
    const testMetrics = toPeriodMetrics(evaluateRaces(test, evaluationModel, options.criteria, payouts), {
        from: testFrom,
        to: dataTo,
    });

    return {
        parameters: fitModel(samples, { l2: selected.l2 }),
        split: { historyFrom, trainFrom, validFrom: firstBlock.from, testFrom, dataTo },
        selectedL2: selected.l2,
        l2Candidates: byL2.map(({ l2, devLogLoss }) => ({ l2, devLogLoss })),
        races: { train: firstBlock.train.length, dev: dev.races, test: test.length, all: samples.length },
        dev,
        devBlocks,
        test: testMetrics,
        criteria: options.criteria,
    };
}
