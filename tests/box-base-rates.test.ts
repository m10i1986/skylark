//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { createBoxBaseRates } from "../src/predict/base-rates.ts";
import { marketProbabilities } from "../src/predict/market.ts";
import { boxHitProbability } from "../src/predict/trifecta.ts";
import type { RaceRecord } from "../src/predict/types.ts";
import { jraRaceId, race, runner } from "./predict-fixtures.ts";

const FIELD_SIZE = 16;

// 人気順に馬番が並ぶ16頭立てのレース 指定した人気順位の3頭が1〜3着になる
function raceFinishing(sequence: number, topThree: readonly number[], overrides: Partial<RaceRecord> = {}): RaceRecord {
    const runners = Array.from({ length: FIELD_SIZE }, (_, index) => {
        const horseNumber = index + 1;
        const place = topThree.indexOf(horseNumber);
        return runner(horseNumber, { orderOfFinish: place === -1 ? 4 + index : place + 1 });
    });
    return race(jraRaceId(sequence), "2026-02-01", runners, overrides);
}

// 3頭の人気順位の組を 指定の回数ずつ並べたレース
function racesOf(groups: ReadonlyArray<{ topThree: readonly number[]; count: number }>, base = 1): RaceRecord[] {
    let sequence = base;
    return groups.flatMap(({ topThree, count }) =>
        Array.from({ length: count }, () => raceFinishing(sequence++, topThree)),
    );
}

describe("createBoxBaseRates", () => {
    const races = racesOf([
        { topThree: [1, 2, 3], count: 100 },
        { topThree: [1, 2, 9], count: 100 },
        { topThree: [4, 5, 6], count: 20 },
    ]);
    const lookup = createBoxBaseRates(races);

    test("人気上位の頭数ごとのBoxの 実際の的中率を求める", () => {
        const rate = lookup({ trackSurface: "芝", fieldSize: FIELD_SIZE }, [3, 4, 6, 9]);

        expect(rate?.races).toBe(220);
        expect(rate?.condition).toBe("芝 16頭以上");
        expect(rate?.topPopularityBoxes.map((box) => [box.horses, box.actualHitRate])).toEqual([
            [3, 0.455],
            [4, 0.455],
            [6, 0.545],
            [9, 1],
        ]);
    });

    test("Harville式の的中率は 市場の勝率から求めた平均と一致する", () => {
        const odds = Array.from({ length: FIELD_SIZE }, (_, index) => 2 + (index + 1) * 3);
        const probabilities = marketProbabilities(odds);
        const expected = boxHitProbability(probabilities, [0, 1, 2, 3]);

        const rate = lookup({ trackSurface: "芝", fieldSize: FIELD_SIZE }, [4]);

        expect(rate?.topPopularityBoxes[0]?.harvilleHitRate).toBeCloseTo(expected, 3);
    });

    test("3着以内に入った馬を人気順位の帯ごとに数え 人気薄が入った割合を求める", () => {
        const rate = lookup({ trackSurface: "芝", fieldSize: FIELD_SIZE }, [3]);

        expect(rate?.averageTopThreeByPopularity).toEqual({
            popularity1to3: 2.273,
            popularity4to6: 0.273,
            popularity7to9: 0.455,
            popularity10OrLower: 0,
        });
        expect(rate?.longshotInTopThreeRate).toBe(0.455);
    });

    test("同じ条件のレースが少ない馬場は 馬場を問わない集計へ広げる", () => {
        const rate = lookup({ trackSurface: "ダ", fieldSize: FIELD_SIZE }, [3]);
        expect(rate?.condition).toBe("16頭以上");
        expect(rate?.races).toBe(220);
    });

    test("頭数の帯が違うレースは集計に含めない 条件に合うレースが少なければ null", () => {
        expect(lookup({ trackSurface: "芝", fieldSize: 10 }, [3])).toBeNull();
        expect(createBoxBaseRates(races.slice(0, 199))({ trackSurface: "芝", fieldSize: FIELD_SIZE }, [3])).toBeNull();
    });

    test("地方競馬と 3着以内が3頭に定まらない同着のレースは集計しない", () => {
        const local = raceFinishing(1, [1, 2, 3]);
        local.raceId = 202611010101;
        const deadHeat = raceFinishing(2, [1, 2, 3]);
        deadHeat.runners = deadHeat.runners.map((entry) =>
            entry.horseNumber === 4 ? { ...entry, orderOfFinish: 3 } : entry,
        );
        const ordinary = racesOf([{ topThree: [1, 2, 3], count: 200 }], 10);

        const rate = createBoxBaseRates([local, deadHeat, ...ordinary])(
            { trackSurface: "芝", fieldSize: FIELD_SIZE },
            [3],
        );

        expect(rate?.races).toBe(200);
    });

    test("同じ条件を繰り返し求めても同じ結果を返す", () => {
        const first = lookup({ trackSurface: "芝", fieldSize: FIELD_SIZE }, [4, 3]);
        const second = lookup({ trackSurface: "芝", fieldSize: FIELD_SIZE }, [3, 4]);
        expect(second).toBe(first);
    });
});
