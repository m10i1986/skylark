//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { buildRaceSamples } from "../src/predict/dataset.ts";
import { evaluatePeriod, payoutKey } from "../src/predict/evaluation.ts";
import { FEATURE_NAMES } from "../src/predict/history.ts";
import {
    type ModelParameters,
    parseModelParameters,
    probabilitiesOfRace,
    standardizationOf,
} from "../src/predict/model.ts";
import { addDays, defaultTrainOptions, InsufficientDataError, trainPredictionModel } from "../src/predict/train.ts";
import type { RaceRecord } from "../src/predict/types.ts";
import { DEFAULT_VALUE_CRITERIA } from "../src/predict/value.ts";
import { jraRaceId, race, runner, seededRandom } from "./predict-fixtures.ts";

// 市場をそのまま信じるモデル(特徴量の係数が0)
function marketOnlyModel(): ModelParameters {
    return {
        version: 1,
        featureNames: [...FEATURE_NAMES],
        means: FEATURE_NAMES.map(() => 0),
        stds: FEATURE_NAMES.map(() => 1),
        coefficients: FEATURE_NAMES.map(() => 0),
        marketCoefficient: 1,
        l2: 1,
    };
}

// 強さに比例して勝ち馬を引き オッズは強さから(控除20%で)付ける 市場は正しい世界
function simulateCalendar(dayCount: number, racesPerDay: number, seed: number): RaceRecord[] {
    const random = seededRandom(seed);
    const races: RaceRecord[] = [];
    let sequence = 0;
    for (let day = 0; day < dayCount; day++) {
        const date = addDays("2025-01-05", day);
        for (let index = 0; index < racesPerDay; index++) {
            sequence += 1;
            const strengths = Array.from({ length: 10 }, () => 0.2 + random());
            const total = strengths.reduce((sum, value) => sum + value, 0);
            let draw = random() * total;
            let winner = 0;
            for (const [horse, strength] of strengths.entries()) {
                draw -= strength;
                if (draw <= 0) {
                    winner = horse;
                    break;
                }
            }
            const odds = strengths.map((strength) => Math.max(1.1, (0.8 * total) / strength));
            const ranks = odds.map((value) => 1 + odds.filter((other) => other < value).length);
            const finishers = strengths
                .map((strength, horse) => ({ horse, key: horse === winner ? Number.POSITIVE_INFINITY : strength }))
                .sort((a, b) => b.key - a.key);
            const runners = strengths.map((_, horse) =>
                runner(horse + 1, {
                    horseId: 1 + ((sequence * 7 + horse * 13) % 60),
                    jockeyId: `j${(sequence + horse) % 12}`,
                    trainerId: `t${(sequence + horse * 3) % 9}`,
                    orderOfFinish: 1 + finishers.findIndex((finisher) => finisher.horse === horse),
                    odds: odds[horse] ?? 2,
                    popularity: ranks[horse] ?? 1,
                }),
            );
            races.push(race(jraRaceId(sequence), date, runners));
        }
    }
    return races;
}

describe("probabilitiesOfRace", () => {
    test("equals the market when the model only trusts the market", () => {
        const features = [
            [0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0.5, 55, 4, 0, 0, 0.075, 0.075],
            [0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0.5, 55, 4, 0, 0, 0.075, 0.075],
            [0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0.5, 55, 4, 0, 0, 0.075, 0.075],
        ];
        const { market, model } = probabilitiesOfRace(marketOnlyModel(), features, [2, 4, 8]);
        for (const [index, probability] of market.entries()) {
            expect(model[index]).toBeCloseTo(probability, 12);
        }
        expect(model.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    });

    test("a market coefficient above 1 moves probability from long shots to favorites", () => {
        const features = [[], []].map(() => FEATURE_NAMES.map(() => 0));
        const sharpened = { ...marketOnlyModel(), marketCoefficient: 1.2 };
        const { market, model } = probabilitiesOfRace(sharpened, features, [2, 20]);
        expect(model[0]).toBeGreaterThan(market[0] ?? 1);
        expect(model[1]).toBeLessThan(market[1] ?? 0);
    });
});

describe("standardizationOf", () => {
    test("uses 1 as the deviation of a constant feature", () => {
        const { samples } = buildRaceSamples([race(jraRaceId(1), "2026-02-01", [runner(1), runner(2), runner(3)])], {
            sampleFrom: "2026-01-01",
            circuit: "jra",
        });
        const { means, stds } = standardizationOf(samples);
        const ageIndex = FEATURE_NAMES.indexOf("age");
        expect(means[ageIndex]).toBe(4);
        expect(stds[ageIndex]).toBe(1);
    });
});

describe("parseModelParameters", () => {
    test("restores a model that went through JSON", () => {
        const restored = parseModelParameters(JSON.parse(JSON.stringify(marketOnlyModel())));
        expect(restored).toEqual(marketOnlyModel());
    });

    test("rejects a model made for different features", () => {
        const stale = { ...marketOnlyModel(), featureNames: ["only_one"] };
        expect(() => parseModelParameters(stale)).toThrow(/train the model again/);
    });

    test("rejects malformed values", () => {
        expect(() => parseModelParameters(null)).toThrow(TypeError);
        expect(() => parseModelParameters({ ...marketOnlyModel(), version: 2 })).toThrow(TypeError);
        expect(() => parseModelParameters({ ...marketOnlyModel(), coefficients: [1] })).toThrow(TypeError);
        expect(() => parseModelParameters({ ...marketOnlyModel(), marketCoefficient: "1" })).toThrow(TypeError);
        expect(() => parseModelParameters({ ...marketOnlyModel(), means: [Number.NaN] })).toThrow(TypeError);
    });
});

describe("evaluatePeriod", () => {
    // 1番が人気薄(30倍)で勝つレースと 人気馬(2番)が勝つレース
    const upset = race(jraRaceId(1), "2026-03-01", [
        runner(1, { odds: 30, popularity: 5, orderOfFinish: 1 }),
        runner(2, { odds: 2, popularity: 1, orderOfFinish: 2 }),
        runner(3, { odds: 4, popularity: 2, orderOfFinish: 3 }),
        runner(4, { odds: 8, popularity: 3, orderOfFinish: 4 }),
        runner(5, { odds: 20, popularity: 4, orderOfFinish: 5 }),
    ]);
    const favorite = race(jraRaceId(2), "2026-03-08", [
        runner(1, { odds: 30, popularity: 5, orderOfFinish: 5 }),
        runner(2, { odds: 2, popularity: 1, orderOfFinish: 1 }),
        runner(3, { odds: 4, popularity: 2, orderOfFinish: 2 }),
        runner(4, { odds: 8, popularity: 3, orderOfFinish: 3 }),
        runner(5, { odds: 20, popularity: 4, orderOfFinish: 4 }),
    ]);

    test("with a market-only model the log loss equals the market's and picks are paid from the payoff table", () => {
        const { samples } = buildRaceSamples([upset, favorite], { sampleFrom: "2026-03-01", circuit: "jra" });
        // 人気薄を拾う緩い条件: オッズ10以上 人気4位以下 期待値の条件なし 勝率の順位は全馬
        const criteria = { minOdds: 10, minPopularity: 4, maxModelRank: 5, minExpectedValue: 0 };
        // 払戻表の値(2,980円)は オッズ30からの推定(3,000円)とは別の値にして 払戻表を使うことを確かめる
        const payouts = new Map([[payoutKey(upset.raceId, 1), 2980]]);
        const metrics = evaluatePeriod(samples, marketOnlyModel(), criteria, payouts, {
            from: "2026-03-01",
            to: "2026-03-08",
        });

        expect(metrics.races).toBe(2);
        expect(metrics.meanLogLoss.model).toBeCloseTo(metrics.meanLogLoss.market, 12);
        // 条件に合うのは 1番(30倍 5番人気)と5番(20倍 4番人気)の2頭 x 2レース = 4頭
        expect(metrics.valuePicks.bets).toBe(4);
        expect(metrics.valuePicks.hits).toBe(1);
        expect(metrics.valuePicks.hitRate).toBeCloseTo(0.25, 12);
        // 払戻は的中した1頭の29.8倍だけ 4頭に100円ずつ賭けて 2980円
        expect(metrics.valuePicks.returnRate).toBeCloseTo(29.8 / 4, 12);
        expect(metrics.longshotBaseline.bets).toBe(4);
        // 本命の的中: 1レース目は外れ 2レース目は当たり
        expect(metrics.top1HitRate.market).toBeCloseTo(0.5, 12);
    });

    test("falls back to the odds when the payoff table has no row", () => {
        const { samples } = buildRaceSamples([upset], { sampleFrom: "2026-03-01", circuit: "jra" });
        const criteria = { minOdds: 10, minPopularity: 5, maxModelRank: 5, minExpectedValue: 0 };
        const metrics = evaluatePeriod(samples, marketOnlyModel(), criteria, new Map(), { from: "a", to: "b" });
        expect(metrics.valuePicks).toMatchObject({ bets: 1, hits: 1 });
        expect(metrics.valuePicks.returnRate).toBeCloseTo(30, 12);
    });

    test("reports zeros without dividing by zero when nothing is picked", () => {
        const { samples } = buildRaceSamples([favorite], { sampleFrom: "2026-03-01", circuit: "jra" });
        // どの馬も100倍に届かないため 何も抽出されない
        const criteria = { ...DEFAULT_VALUE_CRITERIA, minOdds: 100 };
        const metrics = evaluatePeriod(samples, marketOnlyModel(), criteria, new Map(), { from: "a", to: "b" });
        expect(metrics.valuePicks.bets).toBe(0);
        expect(metrics.valuePicks.returnRate).toBe(0);
        expect(Number.isFinite(metrics.valuePicks.returnRateStandardError)).toBe(true);
    });
});

describe("trainPredictionModel", () => {
    const options = {
        ...defaultTrainOptions(DEFAULT_VALUE_CRITERIA),
        burnInDays: 30,
        validDays: 60,
        testDays: 60,
        l2Candidates: [10, 1000],
    };

    test("splits by date, never trains on the test period, and stays close to the market when the market is right", () => {
        const races = simulateCalendar(400, 2, 21);
        const result = trainPredictionModel(races, new Map(), options);

        expect(result.split.trainFrom).toBe(addDays("2025-01-05", 30));
        expect(result.split.dataTo).toBe(addDays("2025-01-05", 399));
        expect(result.split.testFrom).toBe(addDays(result.split.dataTo, -59));
        expect(result.split.validFrom).toBe(addDays(result.split.testFrom, -60));
        expect(result.races.test).toBe(120);
        expect(result.races.valid).toBe(120);
        expect(result.races.train).toBeGreaterThan(400);
        // 市場が正しい世界では 市場の係数は1付近で 特徴量は市場に何も足さない
        expect(result.parameters.marketCoefficient).toBeGreaterThan(0.8);
        expect(result.parameters.marketCoefficient).toBeLessThan(1.2);
        expect(Math.abs(result.test.meanLogLoss.model - result.test.meanLogLoss.market)).toBeLessThan(0.05);
        expect([10, 1000]).toContain(result.selectedL2);
        expect(result.l2Candidates).toHaveLength(2);
    });

    test("the test period does not affect the saved model", () => {
        const races = simulateCalendar(400, 2, 21);
        const baseline = trainPredictionModel(races, new Map(), options);
        // テスト期間のレースだけ 勝ち馬を最下位の馬に入れ替える
        const tampered = races.map((target) =>
            target.date >= baseline.split.testFrom
                ? {
                      ...target,
                      runners: target.runners.map((entry) => ({
                          ...entry,
                          orderOfFinish: 11 - (entry.orderOfFinish ?? 10),
                      })),
                  }
                : target,
        );
        const retrained = trainPredictionModel(tampered, new Map(), options);
        expect(retrained.parameters.coefficients).toEqual(baseline.parameters.coefficients);
        expect(retrained.parameters.marketCoefficient).toBe(baseline.parameters.marketCoefficient);
        expect(retrained.test.meanLogLoss.model).not.toBeCloseTo(baseline.test.meanLogLoss.model, 3);
    });

    test("throws InsufficientDataError when there is not enough data", () => {
        expect(() => trainPredictionModel([], new Map(), options)).toThrow(InsufficientDataError);
        expect(() => trainPredictionModel(simulateCalendar(150, 1, 1), new Map(), options)).toThrow(
            InsufficientDataError,
        );
    });
});

describe("addDays", () => {
    test("moves across month and year boundaries and leap days", () => {
        expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
        expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
        expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    });
});
