//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { buildRaceSamples } from "./dataset.ts";
import { evaluatePeriod, type PeriodMetrics, type WinPayouts } from "./evaluation.ts";
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
    // データの最終日から数えた検証期間・テスト期間の日数
    validDays: number;
    testDays: number;
    // 試すL2正則化の強さ 検証期間の対数損失が最小のものを使う
    l2Candidates: readonly number[];
};

/** 既定の学習・評価の設定を作る */
export function defaultTrainOptions(criteria: ValueCriteria): TrainOptions {
    return {
        circuit: "jra",
        criteria,
        burnInDays: 90,
        validDays: 100,
        testDays: 100,
        l2Candidates: [10, 100, 1000, 3000],
    };
}

/** 期間の区切り すべて開催日(YYYY-MM-DD) */
export type TrainingSplit = {
    // 履歴を蓄積し始めた日(最古のレース)
    historyFrom: string;
    // 学習期間の開始日(助走期間の後)
    trainFrom: string;
    // 検証期間の開始日(L2の選択に使う)
    validFrom: string;
    // テスト期間の開始日(学習にも選択にも使わない)
    testFrom: string;
    // サンプルの最終日
    dataTo: string;
};

/** 学習の結果 */
export type TrainingResult = {
    parameters: ModelParameters;
    split: TrainingSplit;
    selectedL2: number;
    l2Candidates: Array<{ l2: number; validLogLoss: number }>;
    races: { train: number; valid: number; test: number };
    // 学習期間だけで学習したモデルの検証期間の成績
    valid: PeriodMetrics;
    // 保存するモデル(学習期間と検証期間で学習)のテスト期間の成績
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

/**
 * 過去のレースからモデルを学習し 検証期間とテスト期間で評価する
 *
 * 手順
 *  1. 学習期間で各L2のモデルを学習し 検証期間の対数損失が最小のL2を選ぶ
 *  2. 選んだL2で 学習期間 + 検証期間 のモデルを学習する(保存するモデル)
 *  3. 一度も使っていないテスト期間で成績を測る
 *
 * @param races - 結果が確定した全レース(順不同でよい)
 * @param payouts - 単勝の払戻
 * @param options - 学習・評価の設定
 * @returns 学習済みモデルと評価
 * @throws {InsufficientDataError} 学習・検証・テストのいずれかのレースが足りない場合
 */
export function trainPredictionModel(
    races: readonly RaceRecord[],
    payouts: WinPayouts,
    options: TrainOptions,
): TrainingResult {
    if (races.length === 0) {
        throw new InsufficientDataError("no races to train on");
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
    const validFrom = addDays(testFrom, -options.validDays);
    const train = samplesBetween(samples, trainFrom, validFrom);
    const valid = samplesBetween(samples, validFrom, testFrom);
    const test = samplesBetween(samples, testFrom, null);
    if (train.length < MIN_TRAIN_RACES || valid.length === 0 || test.length === 0) {
        throw new InsufficientDataError(
            `not enough races: train=${train.length} (need ${MIN_TRAIN_RACES}), valid=${valid.length}, test=${test.length}`,
        );
    }

    const validRange = { from: validFrom, to: addDays(testFrom, -1) };
    const candidates = options.l2Candidates.map((l2) => {
        const metrics = evaluatePeriod(valid, fitModel(train, { l2 }), options.criteria, payouts, validRange);
        return { l2, validLogLoss: metrics.meanLogLoss.model };
    });
    const selected = candidates.reduce((best, candidate) =>
        candidate.validLogLoss < best.validLogLoss ? candidate : best,
    );

    const trainOnly = fitModel(train, { l2: selected.l2 });
    const parameters = fitModel([...train, ...valid], { l2: selected.l2 });
    return {
        parameters,
        split: { historyFrom, trainFrom, validFrom, testFrom, dataTo },
        selectedL2: selected.l2,
        l2Candidates: candidates,
        races: { train: train.length, valid: valid.length, test: test.length },
        valid: evaluatePeriod(valid, trainOnly, options.criteria, payouts, validRange),
        test: evaluatePeriod(test, parameters, options.criteria, payouts, { from: testFrom, to: dataTo }),
        criteria: options.criteria,
    };
}
