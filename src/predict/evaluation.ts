//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { winnerWeightsOf } from "./conditional-logit.ts";
import { type ModelParameters, probabilitiesOfRace } from "./model.ts";
import type { RaceSample } from "./types.ts";
import { assessRace, type RunnerAssessment, type ValueCriteria } from "./value.ts";

/** 単勝の払戻(100円あたりの円) キーは payoutKey の値 */
export type WinPayouts = ReadonlyMap<string, number>;

/**
 * 単勝の払戻を引くキーを作る
 *
 * @param raceId - レースID
 * @param horseNumber - 馬番
 * @returns キー
 */
export function payoutKey(raceId: number, horseNumber: number): string {
    return `${raceId}:${horseNumber}`;
}

/** 単勝を100円ずつ買い続けた場合の成績 */
export type PickStats = {
    bets: number;
    hits: number;
    hitRate: number;
    meanOdds: number;
    // モデルが見積もった的中率の平均 実際の的中率と近ければ校正できている
    meanPredictedProbability: number;
    // 払戻 / 賭け金 1なら元本どおり
    returnRate: number;
    // 回収率の標準誤差 賭けた数が少ないと回収率は大きくぶれる
    returnRateStandardError: number;
};

/** 1回の賭けの結果 */
export type BetOutcome = { odds: number; modelProbability: number; isHit: boolean; payoutMultiple: number };

function summarizeBets(bets: readonly BetOutcome[]): PickStats {
    const count = bets.length;
    if (count === 0) {
        return {
            bets: 0,
            hits: 0,
            hitRate: 0,
            meanOdds: 0,
            meanPredictedProbability: 0,
            returnRate: 0,
            returnRateStandardError: 0,
        };
    }
    const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / count;
    const returns = bets.map((bet) => bet.payoutMultiple);
    const returnRate = mean(returns);
    const variance = count > 1 ? returns.reduce((sum, value) => sum + (value - returnRate) ** 2, 0) / (count - 1) : 0;
    const hits = bets.filter((bet) => bet.isHit).length;
    return {
        bets: count,
        hits,
        hitRate: hits / count,
        meanOdds: mean(bets.map((bet) => bet.odds)),
        meanPredictedProbability: mean(bets.map((bet) => bet.modelProbability)),
        returnRate,
        returnRateStandardError: Math.sqrt(variance / count),
    };
}

/** レースごとの対数損失の差(市場 - モデル)の平均と標準誤差 */
export type ImprovementStats = {
    // 正ならモデルが市場より良い
    mean: number;
    // 同じ開催日のレースは結果が相関するため 開催日ごとにまとめて求めた標準誤差
    standardError: number;
};

/** 期間ごとの評価指標 */
export type PeriodMetrics = {
    from: string;
    to: string;
    races: number;
    // 勝ち馬に付けた確率の対数損失の平均(小さいほど良い) モデルが市場より小さければ上積みがある
    meanLogLoss: { market: number; model: number };
    // 対数損失の改善(市場 - モデル)が 誤差を超えているかを見るための平均と標準誤差
    improvement: ImprovementStats;
    // 勝率が最も高いと見積もった馬が実際に勝った割合
    top1HitRate: { market: number; model: number };
    // 抽出条件を満たす馬
    valuePicks: PickStats;
    // 比較用 モデルを使わず オッズと人気の条件だけが同じ馬
    longshotBaseline: PickStats;
};

function argmax(values: readonly number[]): number {
    let best = 0;
    for (const [index, value] of values.entries()) {
        if (value > (values[best] ?? Number.NEGATIVE_INFINITY)) {
            best = index;
        }
    }
    return best;
}

function toOutcome(sample: RaceSample, index: number, assessment: RunnerAssessment, payouts: WinPayouts): BetOutcome {
    const isHit = sample.isWinners[index] === true;
    // 払戻表に無い場合は オッズからの推定で補う
    const payout = payouts.get(payoutKey(sample.raceId, assessment.horseNumber)) ?? assessment.odds * 100;
    return {
        odds: assessment.odds,
        modelProbability: assessment.modelProbability,
        isHit,
        payoutMultiple: isHit ? payout / 100 : 0,
    };
}

/** 1レースの対数損失の差(市場 - モデル)と その開催日 */
type RaceDifference = { date: string; value: number };

/**
 * レースごとの差の平均と 開催日ごとにまとめた標準誤差を求める
 *
 * 同じ日のレースは 馬場や天候を共有して結果が相関するため レース数ではなく開催日の単位でばらつきを見る
 *
 * @param differences - レースごとの差
 * @returns 平均と標準誤差 レースが無い場合は0
 */
export function summarizeImprovement(differences: readonly RaceDifference[]): ImprovementStats {
    const count = differences.length;
    if (count === 0) {
        return { mean: 0, standardError: 0 };
    }
    const mean = differences.reduce((sum, difference) => sum + difference.value, 0) / count;
    const deviationByDate = new Map<string, number>();
    for (const difference of differences) {
        deviationByDate.set(difference.date, (deviationByDate.get(difference.date) ?? 0) + difference.value - mean);
    }
    let squareSum = 0;
    for (const deviation of deviationByDate.values()) {
        squareSum += deviation * deviation;
    }
    return { mean, standardError: Math.sqrt(squareSum) / count };
}

/** 評価の途中経過 複数の期間を合算して指標を求めるために 平均にする前の合計を持つ */
export type EvaluationAccumulator = {
    races: number;
    logLossTotals: { market: number; model: number };
    top1Hits: { market: number; model: number };
    pickBets: BetOutcome[];
    baselineBets: BetOutcome[];
    differences: RaceDifference[];
};

/**
 * 期間内のレースでモデルを評価し 合算できる形で返す
 *
 * @param samples - 評価するレース(開催日の昇順)
 * @param parameters - 学習済みモデル
 * @param criteria - 抽出条件
 * @param payouts - 単勝の払戻
 * @returns 評価の途中経過
 */
export function evaluateRaces(
    samples: readonly RaceSample[],
    parameters: ModelParameters,
    criteria: ValueCriteria,
    payouts: WinPayouts,
): EvaluationAccumulator {
    const accumulator: EvaluationAccumulator = {
        races: 0,
        logLossTotals: { market: 0, model: 0 },
        top1Hits: { market: 0, model: 0 },
        pickBets: [],
        baselineBets: [],
        differences: [],
    };

    for (const sample of samples) {
        const weights = winnerWeightsOf(sample.isWinners);
        if (weights == null) {
            continue;
        }
        accumulator.races += 1;
        const probabilities = probabilitiesOfRace(parameters, sample.features, sample.odds);
        const raceLoss = { market: 0, model: 0 };
        for (const kind of ["market", "model"] as const) {
            const values = probabilities[kind];
            raceLoss[kind] = -weights.reduce(
                (sum, weight, index) => sum + weight * Math.log(Math.max(values[index] ?? 0, 1e-12)),
                0,
            );
            accumulator.logLossTotals[kind] += raceLoss[kind];
            accumulator.top1Hits[kind] += sample.isWinners[argmax(values)] === true ? 1 : 0;
        }
        accumulator.differences.push({ date: sample.date, value: raceLoss.market - raceLoss.model });

        const assessments = assessRace(
            {
                horseNumbers: sample.horseNumbers,
                odds: sample.odds,
                popularities: sample.popularities,
                marketProbabilities: probabilities.market,
                modelProbabilities: probabilities.model,
            },
            criteria,
        );
        for (const [index, assessment] of assessments.entries()) {
            if (assessment.odds >= criteria.minOdds && assessment.popularity >= criteria.minPopularity) {
                const outcome = toOutcome(sample, index, assessment, payouts);
                accumulator.baselineBets.push(outcome);
                if (assessment.isValuePick) {
                    accumulator.pickBets.push(outcome);
                }
            }
        }
    }
    return accumulator;
}

/**
 * 複数の期間の評価の途中経過を 1つに合算する
 *
 * @param parts - 期間ごとの途中経過
 * @returns 合算した途中経過
 */
export function combineEvaluations(parts: readonly EvaluationAccumulator[]): EvaluationAccumulator {
    return {
        races: parts.reduce((sum, part) => sum + part.races, 0),
        logLossTotals: {
            market: parts.reduce((sum, part) => sum + part.logLossTotals.market, 0),
            model: parts.reduce((sum, part) => sum + part.logLossTotals.model, 0),
        },
        top1Hits: {
            market: parts.reduce((sum, part) => sum + part.top1Hits.market, 0),
            model: parts.reduce((sum, part) => sum + part.top1Hits.model, 0),
        },
        pickBets: parts.flatMap((part) => part.pickBets),
        baselineBets: parts.flatMap((part) => part.baselineBets),
        differences: parts.flatMap((part) => part.differences),
    };
}

/**
 * 評価の途中経過から 期間の評価指標を求める
 *
 * @param accumulator - 評価の途中経過
 * @param range - 期間の開始日と終了日(表示用)
 * @returns 評価指標
 */
export function toPeriodMetrics(
    accumulator: EvaluationAccumulator,
    range: { from: string; to: string },
): PeriodMetrics {
    const { races } = accumulator;
    const perRace = (totals: { market: number; model: number }) => ({
        market: races === 0 ? 0 : totals.market / races,
        model: races === 0 ? 0 : totals.model / races,
    });
    return {
        ...range,
        races,
        meanLogLoss: perRace(accumulator.logLossTotals),
        improvement: summarizeImprovement(accumulator.differences),
        top1HitRate: perRace(accumulator.top1Hits),
        valuePicks: summarizeBets(accumulator.pickBets),
        longshotBaseline: summarizeBets(accumulator.baselineBets),
    };
}

/**
 * 期間内のレースでモデルを評価する
 *
 * @param samples - 評価するレース(開催日の昇順)
 * @param parameters - 学習済みモデル
 * @param criteria - 抽出条件
 * @param payouts - 単勝の払戻
 * @param range - 期間の開始日と終了日(表示用)
 * @returns 評価指標
 */
export function evaluatePeriod(
    samples: readonly RaceSample[],
    parameters: ModelParameters,
    criteria: ValueCriteria,
    payouts: WinPayouts,
    range: { from: string; to: string },
): PeriodMetrics {
    return toPeriodMetrics(evaluateRaces(samples, parameters, criteria, payouts), range);
}
