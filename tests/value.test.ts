//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { assessRace, DEFAULT_VALUE_CRITERIA, type ValueCriteria } from "../src/predict/value.ts";

const CRITERIA: ValueCriteria = { minOdds: 10, minPopularity: 4, maxModelRank: 5, minExpectedValue: 1 };

// 1頭だけを評価して 抽出されるかを返す
function isPicked(overrides: { odds: number; popularity: number | null; modelProbability: number; rank?: number }) {
    // 順位を作るため 指定した順位の分だけ モデルの勝率が高い馬を並べる
    const rank = overrides.rank ?? 1;
    const others = Array.from({ length: rank - 1 }, (_, index) => ({ odds: 3 + index, probability: 0.9 }));
    const input = {
        horseNumbers: [99, ...others.map((_, index) => index + 1)],
        odds: [overrides.odds, ...others.map((other) => other.odds)],
        popularities: [overrides.popularity, ...others.map((_, index) => index + 1)],
        marketProbabilities: [0.05, ...others.map(() => 0.05)],
        modelProbabilities: [overrides.modelProbability, ...others.map((other) => other.probability)],
    };
    const assessment = assessRace(input, CRITERIA)[0];
    if (assessment == null) {
        throw new Error("no assessment");
    }
    return assessment;
}

describe("assessRace", () => {
    test("picks a horse that meets every condition exactly at the boundary", () => {
        // オッズ10.0 人気4位 モデル5位 期待値 0.1 x 10 = 1.0
        const assessment = isPicked({ odds: 10, popularity: 4, modelProbability: 0.1, rank: 5 });
        expect(assessment.isValuePick).toBe(true);
        expect(assessment.expectedValue).toBeCloseTo(1, 12);
        expect(assessment.modelRank).toBe(5);
    });

    test("rejects a horse when any single condition just misses", () => {
        expect(isPicked({ odds: 9.9, popularity: 4, modelProbability: 0.11, rank: 5 }).isValuePick).toBe(false);
        expect(isPicked({ odds: 10, popularity: 3, modelProbability: 0.1, rank: 5 }).isValuePick).toBe(false);
        expect(isPicked({ odds: 10, popularity: 4, modelProbability: 0.1, rank: 6 }).isValuePick).toBe(false);
        expect(isPicked({ odds: 10, popularity: 4, modelProbability: 0.0999, rank: 5 }).isValuePick).toBe(false);
    });

    test("a minimum expected value of 0 disables the expected value condition", () => {
        const input = {
            horseNumbers: [1],
            odds: [10],
            popularities: [5],
            marketProbabilities: [0.05],
            modelProbabilities: [0.01],
        };
        expect(assessRace(input, CRITERIA)[0]?.isValuePick).toBe(false);
        expect(assessRace(input, { ...CRITERIA, minExpectedValue: 0 })[0]?.isValuePick).toBe(true);
    });

    test("derives the popularity from the odds when the site did not give one", () => {
        const input = {
            horseNumbers: [1, 2, 3, 4, 5],
            odds: [2, 3, 5, 8, 12],
            popularities: [null, null, null, null, null],
            marketProbabilities: [0.3, 0.25, 0.2, 0.15, 0.1],
            modelProbabilities: [0.3, 0.25, 0.2, 0.15, 0.1],
        };
        expect(assessRace(input, CRITERIA).map((runner) => runner.popularity)).toEqual([1, 2, 3, 4, 5]);
    });

    test("computes the edge ratio and expected value from the two probabilities", () => {
        const [assessment] = assessRace(
            {
                horseNumbers: [7],
                odds: [20],
                popularities: [8],
                marketProbabilities: [0.04],
                modelProbabilities: [0.06],
            },
            CRITERIA,
        );
        expect(assessment?.edgeRatio).toBeCloseTo(1.5, 12);
        expect(assessment?.expectedValue).toBeCloseTo(1.2, 12);
    });

    test("throws when the inputs have different lengths", () => {
        expect(() =>
            assessRace(
                {
                    horseNumbers: [1, 2],
                    odds: [2],
                    popularities: [1],
                    marketProbabilities: [1],
                    modelProbabilities: [1],
                },
                CRITERIA,
            ),
        ).toThrow(RangeError);
    });

    test("the default criteria follow the definition: high odds, low popularity, top model rank, fair value", () => {
        expect(DEFAULT_VALUE_CRITERIA).toEqual({ minOdds: 10, minPopularity: 4, maxModelRank: 5, minExpectedValue: 1 });
    });
});
