//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { isValidOdds, marketProbabilities, popularityRanksFromOdds, ranksDescending } from "../src/predict/market.ts";

describe("marketProbabilities", () => {
    test("removes the takeout so that the probabilities sum to 1", () => {
        // 1/2 + 1/4 + 1/4 = 1.0 のとき控除がなく そのまま確率になる
        expect(marketProbabilities([2, 4, 4])).toEqual([0.5, 0.25, 0.25]);
        // 1/1.5 + 1/3 + 1/6 = 1.1667 のように1を超えるときは 合計で割って1にそろえる
        const probabilities = marketProbabilities([1.5, 3, 6]);
        expect(probabilities.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
        expect(probabilities[0]).toBeCloseTo(1 / 1.5 / (1 / 1.5 + 1 / 3 + 1 / 6), 12);
    });

    test("keeps the order: a lower odds means a higher probability", () => {
        const probabilities = marketProbabilities([3.4, 12.1, 1.8, 40]);
        expect(probabilities[2]).toBeGreaterThan(probabilities[0] ?? 0);
        expect(probabilities[0]).toBeGreaterThan(probabilities[1] ?? 0);
        expect(probabilities[1]).toBeGreaterThan(probabilities[3] ?? 0);
    });

    test("accepts odds of exactly 1.0 (refund only)", () => {
        expect(marketProbabilities([1, 5]).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    });

    test("rejects empty input and odds that cannot be sold", () => {
        expect(() => marketProbabilities([])).toThrow(RangeError);
        expect(() => marketProbabilities([2, 0.9])).toThrow(RangeError);
        expect(() => marketProbabilities([2, Number.NaN])).toThrow(RangeError);
        expect(() => marketProbabilities([2, Number.POSITIVE_INFINITY])).toThrow(RangeError);
    });
});

describe("isValidOdds", () => {
    test("treats scratched horses (null) and pre-sale values as having no odds", () => {
        expect(isValidOdds(null)).toBe(false);
        expect(isValidOdds(undefined)).toBe(false);
        expect(isValidOdds(Number.NaN)).toBe(false);
        expect(isValidOdds(0)).toBe(false);
        expect(isValidOdds(1)).toBe(true);
        expect(isValidOdds(25.4)).toBe(true);
    });
});

describe("ranks", () => {
    test("popularity ranks follow the odds and share the rank on ties", () => {
        expect(popularityRanksFromOdds([5, 2, 9, 2])).toEqual([3, 1, 4, 1]);
    });

    test("descending ranks put the largest probability first", () => {
        expect(ranksDescending([0.1, 0.5, 0.3, 0.5])).toEqual([4, 1, 3, 1]);
    });
});
