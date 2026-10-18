//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { availableParallelism } from "node:os";

import { runWithConcurrency } from "./concurrency.ts";
import type { FeatureTarget, SkylarkCrud } from "./db/crud.ts";
import type { FeatureRecord } from "./db/schema.ts";
import type { Logger } from "./logger.ts";
import { createProgressReporter, type ProgressReporter } from "./progress.ts";

// 直近何走を平均の対象とするか
const RECENT_RACE_COUNT = 5;
const LONG_RACE_COUNT = 100;
// 1回のupsertにまとめる件数
const UPSERT_BATCH_SIZE = 500;

const SILENT_PROGRESS: ProgressReporter = { advance: () => {}, finish: () => {} };

/** 整数比 [分子, 分母] JSONでは大きな整数も桁を落とさずに表す */
type IntegerRatio = [bigint, bigint];

/** 特徴量の計算結果(jsonbへ保存する形式) 項目名は移植元のまま 誤字も含めて互換のため変更しない */
export type CalculationResult = {
    sppeed_figure_last: number | null;
    speed_figure_avg: number | null;
    winner_avg: number | null;
    disavesr: unknown[] | null;
    distance_avg: unknown[] | null;
    earnings_per_share: number | null;
};

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
    let a = left < 0n ? -left : left;
    let b = right < 0n ? -right : right;
    while (b !== 0n) {
        [a, b] = [b, a % b];
    }
    return a;
}

/**
 * 10進文字列を既約分数へ変換する
 *
 * PythonのDecimal.as_integer_ratio()と同じ結果(分母は正で最小)を返す
 *
 * @param decimal - 「123.4500」のような10進表記
 * @returns [分子, 分母]
 * @throws {SyntaxError} 10進表記でない場合
 */
export function decimalToIntegerRatio(decimal: string): IntegerRatio {
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
    if (!match) {
        throw new SyntaxError(`not a decimal number: ${JSON.stringify(decimal)}`);
    }
    const sign = match[1] === "-" ? -1n : 1n;
    const fraction = match[3] ?? "";
    const numerator = sign * BigInt(`${match[2]}${fraction}`);
    const denominator = 10n ** BigInt(fraction.length);
    const divisor = greatestCommonDivisor(numerator, denominator);
    return [numerator / divisor, denominator / divisor];
}

// 2^53を超える整数は JSON.stringify がそのまま出力できる生のJSON数値として渡す
function integerToJsonNumber(value: bigint): number | object {
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(value);
    }
    return JSON.rawJSON(value.toString());
}

/**
 * 10進文字列を [分子, 分母] のJSON配列へ変換する
 *
 * @param decimal - 10進表記 未取得の場合は undefined
 * @returns JSON配列 未取得の場合は null
 */
export function toRatioJson(decimal: string | undefined): unknown[] | null {
    if (decimal == null) {
        return null;
    }
    const [numerator, denominator] = decimalToIntegerRatio(decimal);
    return [integerToJsonNumber(numerator), integerToJsonNumber(denominator)];
}

function toNumberOrNull(decimal: string | undefined): number | null {
    return decimal == null ? null : Number(decimal);
}

/**
 * 出走1頭分の特徴量を計算する
 *
 * 馬ごとの過去成績(当該レースより前)から 直近の指数 平均着順 距離の傾向 賞金の平均を求める
 *
 * @param crud - リポジトリ
 * @param target - 計算対象
 * @returns 登録用の特徴量
 */
export async function computeFeature(crud: SkylarkCrud, target: FeatureTarget): Promise<FeatureRecord> {
    const { horseId, date, distance } = target;

    const speedFigureLast = await crud.getSpeedFigureLast(horseId, date);
    const speedFigureAvg = await crud.getSpeedFigureAvg(horseId, date, RECENT_RACE_COUNT);
    const winnerAvg = await crud.getWinnerAvg(horseId, date, RECENT_RACE_COUNT);
    const disavesr = distance == null ? undefined : await crud.getDisavesr(horseId, date, distance, LONG_RACE_COUNT);
    const distanceAvg = await crud.getDistanceAvg(horseId, date, LONG_RACE_COUNT);
    const earningsPerShare = await crud.getEarningsPerShare(horseId, date, LONG_RACE_COUNT);

    const calculationResult: CalculationResult = {
        sppeed_figure_last: speedFigureLast ?? null,
        speed_figure_avg: toNumberOrNull(speedFigureAvg),
        winner_avg: toNumberOrNull(winnerAvg),
        disavesr: toRatioJson(disavesr),
        distance_avg: toRatioJson(distanceAvg),
        earnings_per_share: toNumberOrNull(earningsPerShare),
    };

    return {
        horseId,
        raceId: target.raceId,
        jockeyId: target.jockeyId,
        trainerId: target.trainerId,
        calculationResultJson: calculationResult,
    };
}

/** 特徴量作成の設定 */
export type BuildFeaturesOptions = {
    // 同時に計算する出走数
    concurrency: number;
    // 1回のupsertにまとめる件数 省略時は500
    batchSize?: number;
    // 進捗表示を出すか 省略時は出す
    isProgressVisible?: boolean;
    // 指定すると進捗を標準エラー出力ではなくここへ1行ずつ渡す
    writeProgressLine?: (line: string) => void;
    logger: Logger;
};

/**
 * 全出走馬の特徴量を計算してDBへ登録する
 *
 * 計算はDB待ちが中心のため プロセスを分けず 同時実行数を制限した非同期処理で並列化する
 *
 * @param crud - リポジトリ
 * @param options - 作成の設定
 */
export async function buildFeatures(crud: SkylarkCrud, options: BuildFeaturesOptions): Promise<void> {
    const { logger } = options;
    const targets = await crud.listFeatureTargets();
    if (targets == null || targets.length === 0) {
        logger.warning("Failed to retrieve race results.");
        return;
    }

    const batchSize = options.batchSize ?? UPSERT_BATCH_SIZE;
    logger.info("Start feature");
    const progress =
        options.isProgressVisible === false
            ? SILENT_PROGRESS
            : createProgressReporter(targets.length, "feature", { writeLine: options.writeProgressLine });
    let pending: FeatureRecord[] = [];

    const flush = async (): Promise<void> => {
        if (pending.length === 0) {
            return;
        }
        // 待機中に他の計算が追加しても取りこぼさないよう 先に差し替える
        const batch = pending;
        pending = [];
        await crud.upsertFeatures(batch);
    };

    try {
        await runWithConcurrency(targets, options.concurrency, async (target) => {
            // pending.push(await ...) は push 先の配列を await より先に確定するため
            // 待機中に flush が配列を差し替えると 結果が送信済みの旧配列へ入って失われる
            const feature = await computeFeature(crud, target);
            pending.push(feature);
            progress.advance();
            if (pending.length >= batchSize) {
                await flush();
            }
        });
        await flush();
    } finally {
        progress.finish();
    }
    logger.info("End feature");
}

/**
 * 既定の同時実行数を返す
 *
 * @returns CPU数と8の小さい方
 */
export function defaultFeatureConcurrency(): number {
    return Math.min(8, availableParallelism());
}
