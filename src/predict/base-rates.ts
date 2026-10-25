//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

// 過去のレースの実績から 3連単Boxの的中率と 人気薄が3着以内に入る頻度を求める
// Harville式は強い馬ほど上位に偏る仮定のため 人気馬のBoxの的中確率を実際より高く見積もる
// 同じ条件(馬場と頭数)の実績を並べて AIが確率の絶対値を実績で読めるようにする

import { circuitOfRaceId, startersOf } from "./history.ts";
import { marketProbabilities } from "./market.ts";
import { boxHitProbability } from "./trifecta.ts";
import type { RaceRecord } from "./types.ts";

/** 実績の集計に使う開催日の既定の始まり */
export const DEFAULT_BASE_RATE_SINCE = "2016-01-01";

// 条件に合うレースがこの数に満たない場合は 馬場を問わない集計へ広げる それでも満たなければ実績を示さない
const MIN_SEGMENT_RACES = 200;
// 3着以内に入った馬の人気順位の区切り(この順位まで)
const POPULARITY_BAND_ENDS = [3, 6, 9] as const;
// 3着以内に人気がこの順位以下の馬が入ったレースを 人気薄が入ったレースとする
const LONGSHOT_POPULARITY = 7;

const FIELD_BANDS: ReadonlyArray<{ label: string; max: number }> = [
    { label: "8頭以下", max: 8 },
    { label: "9〜11頭", max: 11 },
    { label: "12〜15頭", max: 15 },
    { label: "16頭以上", max: Number.POSITIVE_INFINITY },
];

/** 人気上位の馬を入れたBoxの実績 */
export type TopPopularityBoxRate = {
    // 人気上位から入れた頭数
    horses: number;
    // 市場の勝率から Harville式で求めた的中確率の平均
    harvilleHitRate: number;
    // 実際に3着以内の3頭が全てBoxに入った割合
    actualHitRate: number;
};

/** 3着以内に入った馬を人気順位の帯ごとに数えた 1レースあたりの平均頭数 */
export type TopThreeByPopularity = {
    popularity1to3: number;
    popularity4to6: number;
    popularity7to9: number;
    popularity10OrLower: number;
};

/** 同じ条件の過去のレースの実績 */
export type BoxBaseRate = {
    // 集計の条件(例: 芝 16頭以上)
    condition: string;
    races: number;
    topPopularityBoxes: TopPopularityBoxRate[];
    averageTopThreeByPopularity: TopThreeByPopularity;
    // 3着以内に人気7位以下の馬が1頭以上入ったレースの割合
    longshotInTopThreeRate: number;
};

/** 実績を求める条件 */
export type BaseRateCondition = {
    trackSurface: string | null;
    fieldSize: number;
};

/**
 * 条件に合う実績を返す処理
 *
 * @param condition - レースの馬場と出走頭数
 * @param horseCounts - 的中率を求めるBoxの頭数
 * @returns 実績 条件に合うレースが少なく集計できない場合はnull
 */
export type BoxBaseRateLookup = (condition: BaseRateCondition, horseCounts: readonly number[]) => BoxBaseRate | null;

// 確定したレースの 人気順位ごとの市場の勝率と 3着以内に入った馬の人気順位
type Outcome = {
    trackSurface: string | null;
    bandIndex: number;
    // 人気順(オッズの低い順)の市場の勝率
    probabilities: number[];
    // 3着以内に入った3頭の人気順位(1が最も人気)
    topThreeRanks: number[];
};

function bandIndexOf(fieldSize: number): number {
    const index = FIELD_BANDS.findIndex((band) => fieldSize <= band.max);
    return index === -1 ? FIELD_BANDS.length - 1 : index;
}

// 3着以内の3頭が定まらないレース(同着など)や 出走馬が少ないレースは集計しない
function outcomeOf(race: RaceRecord): Outcome | null {
    const starters = startersOf(race);
    if (starters.length < 4) {
        return null;
    }
    const ordered = starters
        .map((runner) => ({
            horseNumber: runner.horseNumber,
            odds: runner.odds ?? 0,
            isTopThree: runner.orderOfFinish != null && runner.orderOfFinish <= 3,
        }))
        .sort((a, b) => a.odds - b.odds || a.horseNumber - b.horseNumber);
    const topThreeRanks = ordered.flatMap((entry, index) => (entry.isTopThree ? [index + 1] : []));
    if (topThreeRanks.length !== 3) {
        return null;
    }
    return {
        trackSurface: race.trackSurface,
        bandIndex: bandIndexOf(starters.length),
        probabilities: marketProbabilities(ordered.map((entry) => entry.odds)),
        topThreeRanks,
    };
}

const round3 = (value: number): number => Math.round(value * 1_000) / 1_000;

function aggregate(outcomes: readonly Outcome[], condition: string, horseCounts: readonly number[]): BoxBaseRate {
    const topPopularityBoxes = horseCounts.map((horses): TopPopularityBoxRate => {
        let harville = 0;
        let hits = 0;
        for (const outcome of outcomes) {
            const members = Array.from({ length: Math.min(horses, outcome.probabilities.length) }, (_, index) => index);
            harville += boxHitProbability(outcome.probabilities, members);
            hits += outcome.topThreeRanks.every((rank) => rank <= horses) ? 1 : 0;
        }
        return {
            horses,
            harvilleHitRate: round3(harville / outcomes.length),
            actualHitRate: round3(hits / outcomes.length),
        };
    });

    const bands = [0, 0, 0, 0];
    let longshotRaces = 0;
    for (const outcome of outcomes) {
        for (const rank of outcome.topThreeRanks) {
            const found = POPULARITY_BAND_ENDS.findIndex((end) => rank <= end);
            const bandIndex = found === -1 ? POPULARITY_BAND_ENDS.length : found;
            bands[bandIndex] = (bands[bandIndex] ?? 0) + 1;
        }
        longshotRaces += outcome.topThreeRanks.some((rank) => rank >= LONGSHOT_POPULARITY) ? 1 : 0;
    }
    const perRace = (count: number | undefined): number => round3((count ?? 0) / outcomes.length);
    return {
        condition,
        races: outcomes.length,
        topPopularityBoxes,
        averageTopThreeByPopularity: {
            popularity1to3: perRace(bands[0]),
            popularity4to6: perRace(bands[1]),
            popularity7to9: perRace(bands[2]),
            popularity10OrLower: perRace(bands[3]),
        },
        longshotInTopThreeRate: round3(longshotRaces / outcomes.length),
    };
}

/**
 * 過去のレースから 条件ごとの実績を求める処理を作る
 *
 * 中央競馬のレースだけを使う 集計は条件ごとに初めて求めるときに行い 同じ条件は覚えておく
 *
 * @param races - 結果が確定した過去のレース(順不同でよい)
 * @returns 条件から実績を求める処理
 */
export function createBoxBaseRates(races: readonly RaceRecord[]): BoxBaseRateLookup {
    const outcomes = races.flatMap((race) => {
        if (circuitOfRaceId(race.raceId) !== "jra") {
            return [];
        }
        const outcome = outcomeOf(race);
        return outcome == null ? [] : [outcome];
    });
    const cache = new Map<string, BoxBaseRate | null>();

    return (condition, horseCounts) => {
        const bandIndex = bandIndexOf(condition.fieldSize);
        const counts = [...new Set(horseCounts)].sort((a, b) => a - b);
        const key = `${condition.trackSurface ?? ""}|${bandIndex}|${counts.join(",")}`;
        if (cache.has(key)) {
            return cache.get(key) ?? null;
        }

        const inBand = outcomes.filter((outcome) => outcome.bandIndex === bandIndex);
        const sameSurface =
            condition.trackSurface == null
                ? []
                : inBand.filter((outcome) => outcome.trackSurface === condition.trackSurface);
        const bandLabel = FIELD_BANDS[bandIndex]?.label ?? "";
        let result: BoxBaseRate | null = null;
        if (sameSurface.length >= MIN_SEGMENT_RACES) {
            result = aggregate(sameSurface, `${condition.trackSurface} ${bandLabel}`, counts);
        } else if (inBand.length >= MIN_SEGMENT_RACES) {
            result = aggregate(inBand, bandLabel, counts);
        }
        cache.set(key, result);
        return result;
    };
}
