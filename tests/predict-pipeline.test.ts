//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { buildRaceSamples } from "../src/predict/dataset.ts";
import {
    combineEvaluations,
    evaluatePeriod,
    evaluateRaces,
    payoutKey,
    summarizeImprovement,
    toPeriodMetrics,
} from "../src/predict/evaluation.ts";
import { FEATURE_NAMES } from "../src/predict/history.ts";
import {
    fitModel,
    type ModelParameters,
    parseModelParameters,
    probabilitiesOfRace,
    standardizationOf,
} from "../src/predict/model.ts";
import {
    addDays,
    defaultTrainOptions,
    InsufficientDataError,
    trainPredictionModel,
    walkForwardBlocks,
} from "../src/predict/train.ts";
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

describe("summarizeImprovement", () => {
    test("is the mean difference with a standard error computed per race day", () => {
        // 同じ日の2レースは1つの塊として扱う 日ごとの差の合計の ばらつきから標準誤差を求める
        const stats = summarizeImprovement([
            { date: "2026-03-01", value: 0.2 },
            { date: "2026-03-01", value: 0.2 },
            { date: "2026-03-08", value: -0.1 },
            { date: "2026-03-08", value: -0.1 },
        ]);
        expect(stats.mean).toBeCloseTo(0.05, 12);
        // 日ごとの偏差の合計は +0.3 と -0.3 標準誤差 = sqrt(0.09 + 0.09) / 4
        expect(stats.standardError).toBeCloseTo(Math.sqrt(0.18) / 4, 12);
    });

    test("is wider than the per-race error when races of one day move together", () => {
        // 同じ日のレースが同じ向きにずれる場合 レース単位の標準誤差は誤差を小さく見積もる
        const clustered = summarizeImprovement([
            { date: "d1", value: 0.1 },
            { date: "d1", value: 0.1 },
            { date: "d2", value: -0.1 },
            { date: "d2", value: -0.1 },
        ]);
        const independent = summarizeImprovement([
            { date: "d1", value: 0.1 },
            { date: "d2", value: -0.1 },
            { date: "d3", value: 0.1 },
            { date: "d4", value: -0.1 },
        ]);
        expect(clustered.standardError).toBeGreaterThan(independent.standardError);
    });

    test("is zero for no races and for races that all agree", () => {
        expect(summarizeImprovement([])).toEqual({ mean: 0, standardError: 0 });
        const same = summarizeImprovement([
            { date: "d1", value: 0.05 },
            { date: "d2", value: 0.05 },
        ]);
        expect(same.mean).toBeCloseTo(0.05, 12);
        expect(same.standardError).toBeCloseTo(0, 12);
    });
});

describe("combineEvaluations", () => {
    const criteria = { minOdds: 10, minPopularity: 4, maxModelRank: 5, minExpectedValue: 0 };
    const make = (id: number, date: string, winner: number) =>
        race(
            jraRaceId(id),
            date,
            [30, 2, 4, 8, 20].map((odds, index) =>
                runner(index + 1, {
                    odds,
                    popularity: [5, 1, 2, 3, 4][index] ?? 1,
                    orderOfFinish: index + 1 === winner ? 1 : index + 2,
                }),
            ),
        );
    const races = [make(1, "2026-03-01", 1), make(2, "2026-03-08", 2), make(3, "2026-03-15", 5)];
    const { samples } = buildRaceSamples(races, { sampleFrom: "2026-03-01", circuit: "jra" });

    test("pooling the parts gives the same metrics as evaluating all races at once", () => {
        const model = marketOnlyModel();
        const whole = evaluatePeriod(samples, model, criteria, new Map(), { from: "a", to: "b" });
        const pooled = toPeriodMetrics(
            combineEvaluations([
                evaluateRaces(samples.slice(0, 1), model, criteria, new Map()),
                evaluateRaces(samples.slice(1), model, criteria, new Map()),
            ]),
            { from: "a", to: "b" },
        );
        // 合算の順序が違うだけで 浮動小数点の最後の桁がずれる
        expect(pooled.races).toBe(3);
        expect(pooled.meanLogLoss.market).toBeCloseTo(whole.meanLogLoss.market, 12);
        expect(pooled.meanLogLoss.model).toBeCloseTo(whole.meanLogLoss.model, 12);
        expect(pooled.improvement.mean).toBeCloseTo(whole.improvement.mean, 12);
        expect(pooled.improvement.standardError).toBeCloseTo(whole.improvement.standardError, 12);
        expect(pooled.top1HitRate).toEqual(whole.top1HitRate);
        expect(pooled.valuePicks).toEqual(whole.valuePicks);
        expect(pooled.longshotBaseline).toEqual(whole.longshotBaseline);
    });

    test("a model that only trusts the market has no improvement over the market", () => {
        const metrics = evaluatePeriod(samples, marketOnlyModel(), criteria, new Map(), { from: "a", to: "b" });
        expect(metrics.improvement.mean).toBeCloseTo(0, 12);
        expect(metrics.improvement.standardError).toBeCloseTo(0, 12);
    });
});

describe("walkForwardBlocks", () => {
    test("lines up equal blocks that end just before the test period", () => {
        expect(walkForwardBlocks("2026-07-05", 61, 3)).toEqual([
            { from: addDays("2026-07-05", -183), toExclusive: addDays("2026-07-05", -122) },
            { from: addDays("2026-07-05", -122), toExclusive: addDays("2026-07-05", -61) },
            { from: addDays("2026-07-05", -61), toExclusive: "2026-07-05" },
        ]);
    });

    test("returns nothing for zero blocks", () => {
        expect(walkForwardBlocks("2026-07-05", 61, 0)).toEqual([]);
    });
});

describe("trainPredictionModel", () => {
    const options = {
        ...defaultTrainOptions(DEFAULT_VALUE_CRITERIA),
        burnInDays: 30,
        testDays: 60,
        blockDays: 40,
        blockCount: 3,
        l2Candidates: [10, 1000],
    };

    test("splits by date into walk-forward blocks and a test period, and stays close to the market when the market is right", () => {
        const races = simulateCalendar(400, 2, 21);
        const result = trainPredictionModel(races, new Map(), options);

        expect(result.split.trainFrom).toBe(addDays("2025-01-05", 30));
        expect(result.split.dataTo).toBe(addDays("2025-01-05", 399));
        expect(result.split.testFrom).toBe(addDays(result.split.dataTo, -59));
        // 開発期間は テスト期間の直前の 40日 x 3区間
        expect(result.split.validFrom).toBe(addDays(result.split.testFrom, -120));
        expect(result.devBlocks).toHaveLength(3);
        expect(result.devBlocks.map((block) => block.races)).toEqual([80, 80, 80]);
        expect(result.dev.races).toBe(240);
        expect(result.dev.from).toBe(result.split.validFrom);
        expect(result.dev.to).toBe(addDays(result.split.testFrom, -1));
        expect(result.devBlocks[0]?.from).toBe(result.split.validFrom);
        expect(result.devBlocks[2]?.to).toBe(addDays(result.split.testFrom, -1));
        expect(result.races.test).toBe(120);
        expect(result.races.all).toBe(result.races.train + 240 + 120);
        // 市場が正しい世界では 市場の係数は1付近で 特徴量は市場に何も足さない 改善は誤差の範囲に収まる
        expect(result.parameters.marketCoefficient).toBeGreaterThan(0.8);
        expect(result.parameters.marketCoefficient).toBeLessThan(1.2);
        expect(Math.abs(result.test.meanLogLoss.model - result.test.meanLogLoss.market)).toBeLessThan(0.05);
        expect(Math.abs(result.dev.improvement.mean)).toBeLessThan(2 * result.dev.improvement.standardError + 0.01);
        expect([10, 1000]).toContain(result.selectedL2);
        expect(result.l2Candidates.map((candidate) => candidate.l2)).toEqual([10, 1000]);
    });

    test("selects the l2 with the smallest log loss pooled over every block", () => {
        const races = simulateCalendar(400, 2, 21);
        const result = trainPredictionModel(races, new Map(), options);
        const best = result.l2Candidates.reduce((a, b) => (b.devLogLoss < a.devLogLoss ? b : a));
        expect(result.selectedL2).toBe(best.l2);
        // 選んだL2の 全区間の平均と 開発期間全体の対数損失が一致する
        expect(result.dev.meanLogLoss.model).toBeCloseTo(best.devLogLoss, 12);
    });

    test("saves a model refit on every race, including the test period", () => {
        const races = simulateCalendar(400, 2, 21);
        const result = trainPredictionModel(races, new Map(), options);
        const { samples } = buildRaceSamples(races, { sampleFrom: result.split.trainFrom, circuit: "jra" });
        expect(result.races.all).toBe(samples.length);
        expect(result.parameters).toEqual(fitModel(samples, { l2: result.selectedL2 }));
    });

    test("the test period never reaches the selection or the evaluation, only the saved model", () => {
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
        // L2の選択と開発期間の成績は テスト期間に左右されない
        expect(retrained.selectedL2).toBe(baseline.selectedL2);
        expect(retrained.l2Candidates).toEqual(baseline.l2Candidates);
        expect(retrained.dev).toEqual(baseline.dev);
        expect(retrained.devBlocks).toEqual(baseline.devBlocks);
        // テストの成績は 開発期間だけで学習したモデルで測るため 結果を入れ替えると悪化する
        expect(retrained.test.meanLogLoss.model).toBeGreaterThan(baseline.test.meanLogLoss.model + 0.05);
        // 保存するモデルは 全期間で学習し直すため テスト期間の結果も取り込む
        expect(retrained.parameters.coefficients).not.toEqual(baseline.parameters.coefficients);
    });

    test("each block is evaluated by a model that has not seen that block or any later one", () => {
        const races = simulateCalendar(400, 2, 21);
        const baseline = trainPredictionModel(races, new Map(), options);
        const second = baseline.devBlocks[1];
        expect(second).toBeDefined();
        // 2番目の区間のレースだけ 勝ち馬を入れ替える
        const tampered = races.map((target) =>
            second != null && target.date >= second.from && target.date <= second.to
                ? {
                      ...target,
                      runners: target.runners.map((entry) => ({
                          ...entry,
                          orderOfFinish: 11 - (entry.orderOfFinish ?? 10),
                      })),
                  }
                : target,
        );
        const retrained = trainPredictionModel(tampered, new Map(), {
            ...options,
            l2Candidates: [baseline.selectedL2],
        });
        const same = trainPredictionModel(races, new Map(), { ...options, l2Candidates: [baseline.selectedL2] });
        // 最初の区間は それより前のレースだけで学習したモデルで測るため 影響を受けない
        expect(retrained.devBlocks[0]).toEqual(same.devBlocks[0]);
        // 2番目の区間は結果そのものが変わるため成績が変わる
        expect(retrained.devBlocks[1]?.meanLogLoss.model).not.toBeCloseTo(same.devBlocks[1]?.meanLogLoss.model ?? 0, 3);
    });

    test("drops blocks that have too few races to train on before them", () => {
        // 開発期間が短く 古い区間の前には学習に使うレースが足りない
        const races = simulateCalendar(220, 2, 5);
        const result = trainPredictionModel(races, new Map(), { ...options, burnInDays: 10, blockCount: 5 });
        expect(result.devBlocks.length).toBeGreaterThanOrEqual(1);
        expect(result.devBlocks.length).toBeLessThan(5);
        // 要求した5区間の最初の開始日より 実際の開発期間の開始日は遅い(学習に使うレースが足りない古い区間は使わない)
        expect(result.split.validFrom > addDays(result.split.testFrom, -5 * 40)).toBe(true);
        expect(result.split.validFrom).toBe(result.dev.from);
        expect(result.races.train).toBeGreaterThanOrEqual(200);
    });

    test("throws InsufficientDataError when there is not enough data", () => {
        expect(() => trainPredictionModel([], new Map(), options)).toThrow(InsufficientDataError);
        expect(() => trainPredictionModel(simulateCalendar(150, 1, 1), new Map(), options)).toThrow(
            InsufficientDataError,
        );
    });

    test("rejects an empty list of l2 candidates", () => {
        expect(() =>
            trainPredictionModel(simulateCalendar(400, 2, 21), new Map(), { ...options, l2Candidates: [] }),
        ).toThrow(RangeError);
    });
});

describe("addDays", () => {
    test("moves across month and year boundaries and leap days", () => {
        expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
        expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
        expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    });
});
