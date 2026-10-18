//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { popularityRanksFromOdds, ranksDescending } from "./market.ts";

/**
 * 「勝率が高いのに人気がない馬」の抽出条件 すべてを満たす馬が対象
 *
 * 勝率が高い = モデルの勝率がレース内で上位 人気がない = 人気順位が低い かつ オッズが高い
 */
export type ValueCriteria = {
    // 単勝オッズがこの値以上(オッズが高い)
    minOdds: number;
    // 人気順位がこの値以上(数字が大きいほど不人気)
    minPopularity: number;
    // モデルの勝率の順位がこの値以内(1が最上位)
    maxModelRank: number;
    // 期待払戻倍率(モデルの勝率 x オッズ)がこの値以上 0なら条件にしない
    minExpectedValue: number;
};

/**
 * 既定の抽出条件
 *
 * 利用者の定義(オッズが高い・人気が低い・勝率が高い)に沿って決めた値で 回収率を最適化した値ではない
 * モデルの勝率が上位3位以内で人気が4位以下の馬は 市場の順位とほぼ一致するためほとんど現れない
 * そのため「上位5位以内」とし 期待値が1以上(勝率 x オッズ >= 1)の馬だけを残す 抽出される頭数は学習のL2の強さで大きく変わる
 */
export const DEFAULT_VALUE_CRITERIA: ValueCriteria = {
    minOdds: 10,
    minPopularity: 4,
    maxModelRank: 5,
    minExpectedValue: 1,
};

/** 出走馬1頭の評価 */
export type RunnerAssessment = {
    horseNumber: number;
    odds: number;
    // 人気順位 取得できない場合はオッズの低い順から求める
    popularity: number;
    marketProbability: number;
    modelProbability: number;
    modelRank: number;
    // 市場の勝率に対するモデルの勝率の比 1より大きいほど市場が低く見ている
    edgeRatio: number;
    // 期待払戻倍率 モデルの勝率 x オッズ 1を超えると長期的に回収率が100%を超える見込み
    expectedValue: number;
    isValuePick: boolean;
};

/** 評価の入力 */
export type AssessmentInput = {
    horseNumbers: readonly number[];
    odds: readonly number[];
    // サイトが示す人気 取得できない馬はnull
    popularities: ReadonlyArray<number | null>;
    marketProbabilities: readonly number[];
    modelProbabilities: readonly number[];
};

/**
 * レースの出走馬を評価し 抽出条件を満たす馬に印を付ける
 *
 * @param input - 出走馬ごとのオッズ・人気・市場とモデルの勝率
 * @param criteria - 抽出条件
 * @returns 入力と同じ並びの評価
 * @throws {RangeError} 入力の長さが揃っていない場合
 */
export function assessRace(input: AssessmentInput, criteria: ValueCriteria): RunnerAssessment[] {
    const count = input.horseNumbers.length;
    if (
        input.odds.length !== count ||
        input.popularities.length !== count ||
        input.marketProbabilities.length !== count ||
        input.modelProbabilities.length !== count
    ) {
        throw new RangeError("all assessment inputs must have the same length");
    }
    const derivedPopularities = popularityRanksFromOdds(input.odds);
    const modelRanks = ranksDescending(input.modelProbabilities);

    return input.horseNumbers.map((horseNumber, index) => {
        const odds = input.odds[index] ?? 0;
        const popularity = input.popularities[index] ?? derivedPopularities[index] ?? 0;
        const marketProbability = input.marketProbabilities[index] ?? 0;
        const modelProbability = input.modelProbabilities[index] ?? 0;
        const modelRank = modelRanks[index] ?? 0;
        const expectedValue = modelProbability * odds;
        return {
            horseNumber,
            odds,
            popularity,
            marketProbability,
            modelProbability,
            modelRank,
            edgeRatio: marketProbability > 0 ? modelProbability / marketProbability : 0,
            expectedValue,
            isValuePick:
                odds >= criteria.minOdds &&
                popularity >= criteria.minPopularity &&
                modelRank <= criteria.maxModelRank &&
                expectedValue >= criteria.minExpectedValue,
        };
    });
}
