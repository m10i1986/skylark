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
type BetOutcome = { odds: number; modelProbability: number; isHit: boolean; payoutMultiple: number };

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

/** 期間ごとの評価指標 */
export type PeriodMetrics = {
    from: string;
    to: string;
    races: number;
    // 勝ち馬に付けた確率の対数損失の平均(小さいほど良い) モデルが市場より小さければ上積みがある
    meanLogLoss: { market: number; model: number };
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
    const logLossTotals = { market: 0, model: 0 };
    const top1Hits = { market: 0, model: 0 };
    const pickBets: BetOutcome[] = [];
    const baselineBets: BetOutcome[] = [];
    let races = 0;

    for (const sample of samples) {
        const weights = winnerWeightsOf(sample.isWinners);
        if (weights == null) {
            continue;
        }
        races += 1;
        const probabilities = probabilitiesOfRace(parameters, sample.features, sample.odds);
        for (const kind of ["market", "model"] as const) {
            const values = probabilities[kind];
            logLossTotals[kind] -= weights.reduce(
                (sum, weight, index) => sum + weight * Math.log(Math.max(values[index] ?? 0, 1e-12)),
                0,
            );
            top1Hits[kind] += sample.isWinners[argmax(values)] === true ? 1 : 0;
        }

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
                baselineBets.push(outcome);
                if (assessment.isValuePick) {
                    pickBets.push(outcome);
                }
            }
        }
    }

    const perRace = (totals: { market: number; model: number }) => ({
        market: races === 0 ? 0 : totals.market / races,
        model: races === 0 ? 0 : totals.model / races,
    });
    return {
        ...range,
        races,
        meanLogLoss: perRace(logLossTotals),
        top1HitRate: perRace(top1Hits),
        valuePicks: summarizeBets(pickBets),
        longshotBaseline: summarizeBets(baselineBets),
    };
}
