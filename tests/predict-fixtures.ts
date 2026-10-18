//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import type { RaceRecord, RunnerRecord } from "../src/predict/types.ts";

/** テスト用の出走馬 引数で上書きしない項目は標準の値になる */
export function runner(horseNumber: number, overrides: Partial<RunnerRecord> = {}): RunnerRecord {
    return {
        horseNumber,
        horseId: 1000 + horseNumber,
        jockeyId: `j${horseNumber}`,
        trainerId: `t${horseNumber}`,
        sex: "牡",
        age: 4,
        basisWeight: 55,
        orderOfFinish: horseNumber,
        lastPhase: 35 + horseNumber * 0.1,
        odds: 2 + horseNumber * 3,
        popularity: horseNumber,
        ...overrides,
    };
}

/** テスト用のレース raceId は中央競馬(開催場コード05)の範囲 */
export function race(
    raceId: number,
    date: string,
    runners: RunnerRecord[],
    overrides: Partial<RaceRecord> = {},
): RaceRecord {
    return { raceId, date, distance: 1600, trackSurface: "芝", runners, ...overrides };
}

/** 中央競馬(東京)のレースID 連番は1〜999999 */
export function jraRaceId(sequence: number): number {
    return 202605000000 + sequence;
}

/** 決まった系列を返す乱数(mulberry32) テストを再現可能にする */
export function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
