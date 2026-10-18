//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { winnerWeightsOf } from "./conditional-logit.ts";
import { circuitOfRaceId, HistoryState, startersOf } from "./history.ts";
import type { Circuit, RaceRecord, RaceSample } from "./types.ts";

/** 学習用データの作成条件 */
export type BuildSamplesOptions = {
    // この開催日以降のレースだけを学習・評価に使う それより前は履歴の蓄積だけに使う(助走期間)
    sampleFrom: string;
    circuit: Circuit;
};

/** 学習用データの作成結果 */
export type BuiltSamples = {
    samples: RaceSample[];
    // 渡したレースをすべて反映した履歴 当日の予測にそのまま使える
    state: HistoryState;
};

function compareRaces(left: RaceRecord, right: RaceRecord): number {
    if (left.date !== right.date) {
        return left.date < right.date ? -1 : 1;
    }
    return left.raceId - right.raceId;
}

// 結果が確定したレースから 学習・評価の1サンプルを作る 学習できないレースはnull
function toSample(state: HistoryState, race: RaceRecord, circuit: Circuit): RaceSample | null {
    const starters = startersOf(race);
    if (starters.length < 2) {
        return null;
    }
    const isWinners = starters.map((runner) => runner.orderOfFinish === 1);
    if (winnerWeightsOf(isWinners) == null) {
        return null;
    }
    return {
        raceId: race.raceId,
        date: race.date,
        circuit,
        horseNumbers: starters.map((runner) => runner.horseNumber),
        features: state.featureRows(race),
        // startersOf はオッズが有効な馬だけを返す
        odds: starters.map((runner) => runner.odds ?? 0),
        popularities: starters.map((runner) => runner.popularity),
        isWinners,
    };
}

/**
 * 全レースを開催日の順にたどり 学習・評価用のサンプルを作る
 *
 * 各レースの特徴量は それより前の開催日の結果だけから計算する
 * 同じ開催日のレースは 全レースの特徴量を作り終えてから履歴へ反映する
 *
 * @param races - 過去のレース(順不同でよい)
 * @param options - 作成条件
 * @returns サンプル(開催日の昇順)と 全レースを反映した履歴
 */
export function buildRaceSamples(races: readonly RaceRecord[], options: BuildSamplesOptions): BuiltSamples {
    const sorted = [...races].sort(compareRaces);
    const state = new HistoryState();
    const samples: RaceSample[] = [];

    let start = 0;
    while (start < sorted.length) {
        const date = sorted[start]?.date ?? "";
        let end = start;
        while (end < sorted.length && sorted[end]?.date === date) {
            end++;
        }
        const day = sorted.slice(start, end);

        if (date >= options.sampleFrom) {
            for (const race of day) {
                if (circuitOfRaceId(race.raceId) !== options.circuit) {
                    continue;
                }
                const sample = toSample(state, race, options.circuit);
                if (sample != null) {
                    samples.push(sample);
                }
            }
        }
        for (const race of day) {
            state.applyRace(race);
        }
        start = end;
    }
    return { samples, state };
}

/**
 * 過去のレースをすべて反映した履歴を作る 当日の予測用
 *
 * @param races - 結果が確定したレース(順不同でよい)
 * @returns 全レースを反映した履歴
 */
export function buildHistoryState(races: readonly RaceRecord[]): HistoryState {
    const state = new HistoryState();
    for (const race of [...races].sort(compareRaces)) {
        state.applyRace(race);
    }
    return state;
}
