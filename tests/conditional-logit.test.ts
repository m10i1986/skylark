//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import {
    fitConditionalLogit,
    type LogitRace,
    softmax,
    solveSymmetricPositiveDefinite,
    winnerWeightsOf,
} from "../src/predict/conditional-logit.ts";
import { seededRandom } from "./predict-fixtures.ts";

// 真の係数に従って勝ち馬を引き 学習用のレースを作る
function simulateRaces(trueCoefficients: number[], raceCount: number, fieldSize: number, seed: number): LogitRace[] {
    const random = seededRandom(seed);
    const races: LogitRace[] = [];
    for (let index = 0; index < raceCount; index++) {
        const features = Array.from({ length: fieldSize }, () =>
            trueCoefficients.map(() => (random() + random() + random() - 1.5) * 2),
        );
        const probabilities = softmax(
            features.map((row) => row.reduce((sum, value, column) => sum + value * (trueCoefficients[column] ?? 0), 0)),
        );
        let draw = random();
        let winner = fieldSize - 1;
        for (const [horse, probability] of probabilities.entries()) {
            draw -= probability;
            if (draw <= 0) {
                winner = horse;
                break;
            }
        }
        races.push({ features, winnerWeights: features.map((_, horse) => (horse === winner ? 1 : 0)) });
    }
    return races;
}

describe("softmax", () => {
    test("sums to 1 and does not overflow for large scores", () => {
        const probabilities = softmax([1000, 1001, 999]);
        expect(probabilities.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
        expect(probabilities[1]).toBeGreaterThan(probabilities[0] ?? 1);
        expect(probabilities.every(Number.isFinite)).toBe(true);
    });
});

describe("winnerWeightsOf", () => {
    test("splits the weight evenly on a dead heat", () => {
        expect(winnerWeightsOf([true, false, true])).toEqual([0.5, 0, 0.5]);
    });

    test("returns null for a race without a winner", () => {
        expect(winnerWeightsOf([false, false])).toBeNull();
    });
});

describe("solveSymmetricPositiveDefinite", () => {
    test("solves a small system", () => {
        const solution = solveSymmetricPositiveDefinite(
            [
                [4, 1],
                [1, 3],
            ],
            [1, 2],
        );
        expect(solution?.[0]).toBeCloseTo(1 / 11, 12);
        expect(solution?.[1]).toBeCloseTo(7 / 11, 12);
    });

    test("returns null when the matrix is not positive definite", () => {
        expect(
            solveSymmetricPositiveDefinite(
                [
                    [1, 2],
                    [2, 1],
                ],
                [1, 1],
            ),
        ).toBeNull();
    });
});

describe("fitConditionalLogit", () => {
    test("recovers the true coefficients from simulated races", () => {
        const truth = [0.8, -0.5, 0];
        const fit = fitConditionalLogit(simulateRaces(truth, 4000, 8, 7), truth.length, { l2: 0.01 });
        expect(fit.isConverged).toBe(true);
        expect(fit.coefficients[0]).toBeCloseTo(0.8, 1);
        expect(fit.coefficients[1]).toBeCloseTo(-0.5, 1);
        expect(Math.abs(fit.coefficients[2] ?? 1)).toBeLessThan(0.1);
    });

    test("shrinks the coefficients when the regularization is stronger", () => {
        const races = simulateRaces([1.2], 500, 8, 11);
        const weak = fitConditionalLogit(races, 1, { l2: 0.01 }).coefficients[0] ?? 0;
        const strong = fitConditionalLogit(races, 1, { l2: 5000 }).coefficients[0] ?? 0;
        expect(Math.abs(strong)).toBeLessThan(Math.abs(weak));
    });

    test("does not penalize a coefficient whose penalty scale is 0", () => {
        const races = simulateRaces([1.2, 0.7], 2000, 8, 5);
        const penalized = fitConditionalLogit(races, 2, { l2: 1e6 });
        const free = fitConditionalLogit(races, 2, { l2: 1e6, penaltyScales: [0, 1] });
        expect(Math.abs(penalized.coefficients[0] ?? 0)).toBeLessThan(0.01);
        expect(free.coefficients[0]).toBeCloseTo(1.2, 0);
        expect(Math.abs(free.coefficients[1] ?? 0)).toBeLessThan(0.01);
    });

    test("starts from the given coefficients", () => {
        const races = simulateRaces([0.6], 1000, 6, 3);
        const fit = fitConditionalLogit(races, 1, { l2: 0, initial: [0.6] });
        expect(fit.iterations).toBeLessThanOrEqual(5);
    });

    test("handles a dead heat by splitting the winner weight", () => {
        const races: LogitRace[] = [
            {
                features: [[1], [1], [0]],
                winnerWeights: [0.5, 0.5, 0],
            },
        ];
        const fit = fitConditionalLogit(races, 1, { l2: 0.1 });
        expect(Number.isFinite(fit.coefficients[0])).toBe(true);
        expect(fit.coefficients[0]).toBeGreaterThan(0);
    });

    test("rejects invalid settings", () => {
        expect(() => fitConditionalLogit([], 0, { l2: 1 })).toThrow(RangeError);
        expect(() => fitConditionalLogit([], 1, { l2: -1 })).toThrow(RangeError);
        expect(() => fitConditionalLogit([], 2, { l2: 1, initial: [0] })).toThrow(RangeError);
        expect(() => fitConditionalLogit([], 2, { l2: 1, penaltyScales: [1] })).toThrow(RangeError);
    });
});
