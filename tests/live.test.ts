//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { sql } from "drizzle-orm";

import { SkylarkCrud } from "../src/db/crud.ts";
import { PredictionRepository } from "../src/db/prediction-repository.ts";
import { FEATURE_NAMES, HistoryState } from "../src/predict/history.ts";
import {
    formatLocalDate,
    formatRaceLabel,
    predictRace,
    predictToday,
    toPredictionRecords,
    toRaceRecord,
} from "../src/predict/live.ts";
import type { ModelParameters } from "../src/predict/model.ts";
import { formatPredictions, formatTrainingReport, formatVerification } from "../src/predict/report.ts";
import { DEFAULT_VALUE_CRITERIA } from "../src/predict/value.ts";
import type {
    HorseEntry,
    NetkeibaClient,
    RaceDate,
    RaceInformation,
    RaceListItem,
} from "../src/webui/netkeiba-client.ts";
import { createRecordingLogger } from "./mock-fetch.ts";
import { jraRaceId, race, runner } from "./predict-fixtures.ts";
import { createTestDatabase, resultRecord, type TestDatabase } from "./test-database.ts";

const TODAY = "2026-10-18";
// 実行する環境のタイムゾーンによらず ローカル時間の2026-10-18 09:00になる
const NOW = new Date(2026, 9, 18, 9, 0, 0);

function horseEntry(horseNumber: number, overrides: Partial<HorseEntry> = {}): HorseEntry {
    return {
        horseId: 5000 + horseNumber,
        horseNumber,
        wakuNumber: 1,
        horseName: `馬${horseNumber}`,
        barei: "牡4",
        basisWeight: 56,
        jockeyId: "01001",
        jockeyName: "騎手",
        trainerId: "01002",
        trainerName: "調教師",
        odds: 2 + horseNumber * 3,
        popularity: horseNumber,
        horseWeight: 999,
        horseWeightDiff: 0,
        ...overrides,
    };
}

function information(raceId: number, horses: HorseEntry[], raceName = `レース${raceId}`): RaceInformation {
    return {
        race: { id: raceId, raceName, raceNumber: 1, distance: 1600, trackSurface: "芝", postTime: "15:20" },
        horses,
    };
}

// 年齢の係数だけを大きくしたモデル 高齢の馬ほど勝率が高く見積もられる
function ageLovingModel(): ModelParameters {
    return {
        version: 1,
        featureNames: [...FEATURE_NAMES],
        means: FEATURE_NAMES.map(() => 0),
        stds: FEATURE_NAMES.map(() => 1),
        coefficients: FEATURE_NAMES.map((name) => (name === "age" ? 0.5 : 0)),
        marketCoefficient: 1,
        l2: 1,
    };
}

function listItem(raceId: number, raceName: string): RaceListItem {
    return {
        courseName: "東京",
        raceNumber: "1R",
        raceName,
        text: raceName,
        href: `/race/shutuba.html?race_id=${raceId}`,
        raceId,
    };
}

function fakeClient(options: {
    dates?: RaceDate[];
    list?: RaceListItem[];
    informations?: RaceInformation[];
    failFor?: number[];
}): NetkeibaClient {
    return {
        fetchRaceDates: async () =>
            options.dates ?? [{ text: "10/18", href: "race_list.html?kaisai_date=20261018", kaisaiDate: TODAY }],
        fetchRaceList: async () => options.list ?? [],
        fetchRaceInformation: async (raceId) => {
            if (options.failFor?.includes(raceId)) {
                throw new Error("boom");
            }
            const found = options.informations?.find((item) => item.race.id === raceId);
            if (found == null) {
                throw new Error(`unexpected race ${raceId}`);
            }
            return found;
        },
        close: async () => {},
    };
}

describe("formatLocalDate", () => {
    test("uses the local calendar date with zero padding", () => {
        expect(formatLocalDate(new Date(2026, 0, 5, 23, 59, 59))).toBe("2026-01-05");
        expect(formatLocalDate(NOW)).toBe(TODAY);
    });
});

describe("formatRaceLabel", () => {
    test("puts the venue and the race number before the race name so that races of the same name can be told apart", () => {
        expect(formatRaceLabel("4回 東京 7日目", "11R", "ブラジルC")).toBe("東京11R ブラジルC");
        expect(formatRaceLabel("4回 京都 7日目", "4R", "3歳以上1勝クラス")).toBe("京都4R 3歳以上1勝クラス");
        expect(formatRaceLabel("東京", " 1R ", "未勝利")).toBe("東京1R 未勝利");
    });

    test("still gives the race number when the venue cannot be read", () => {
        expect(formatRaceLabel("", "11R", "ブラジルC")).toBe("11R ブラジルC");
        expect(formatRaceLabel("4回 7日目", "2R", "未勝利")).toBe("2R 未勝利");
    });
});

describe("toRaceRecord", () => {
    test("converts the shutuba into the same shape as past races", () => {
        const logger = createRecordingLogger();
        const record = toRaceRecord(information(1, [horseEntry(1, { barei: "牝3", popularity: 2.0 })]), TODAY, logger);
        expect(record).toMatchObject({ raceId: 1, date: TODAY, distance: 1600, trackSurface: "芝" });
        expect(record.runners[0]).toMatchObject({
            horseNumber: 1,
            sex: "牝",
            age: 3,
            popularity: 2,
            orderOfFinish: null,
            lastPhase: null,
        });
        expect(logger.ofLevel("warning")).toEqual([]);
    });

    test("falls back with a warning when the sex/age, the horse id or the weight is unreadable", () => {
        const logger = createRecordingLogger();
        const record = toRaceRecord(
            information(1, [horseEntry(4, { barei: null, horseId: null, basisWeight: null, jockeyId: null })]),
            TODAY,
            logger,
        );
        expect(record.runners[0]).toMatchObject({ sex: "", age: 4, basisWeight: 55, jockeyId: "", horseId: -4 });
        expect(logger.ofLevel("warning").length).toBe(2);
    });

    test("skips a row without a horse number", () => {
        const record = toRaceRecord(
            information(1, [horseEntry(1), horseEntry(2, { horseNumber: null })]),
            TODAY,
            createRecordingLogger(),
        );
        expect(record.runners.map((entry) => entry.horseNumber)).toEqual([1]);
    });
});

describe("predictRace", () => {
    const names = new Map([[6, "穴馬"]]);

    test("returns null before the sale starts, when fewer than two horses have odds", () => {
        const target = race(
            jraRaceId(1),
            TODAY,
            [runner(1, { odds: null, popularity: null }), runner(2, { odds: null, popularity: null })],
            {},
        );
        expect(
            predictRace(target, "x", names, new HistoryState(), ageLovingModel(), DEFAULT_VALUE_CRITERIA, NOW),
        ).toBeNull();
    });

    test("leaves scratched horses out of the market and lists the rest by popularity", () => {
        const target = race(jraRaceId(1), TODAY, [
            runner(1, { odds: 2, popularity: 1 }),
            runner(2, { odds: null, popularity: null }),
            runner(3, { odds: 4, popularity: 2 }),
            runner(6, { odds: 4, popularity: 2 }),
        ]);
        const result = predictRace(
            target,
            "x",
            names,
            new HistoryState(),
            ageLovingModel(),
            DEFAULT_VALUE_CRITERIA,
            NOW,
        );
        expect(result?.runners.map((entry) => entry.horseNumber)).toEqual([1, 3, 6]);
        const total = result?.runners.reduce((sum, entry) => sum + entry.marketProbability, 0) ?? 0;
        expect(total).toBeCloseTo(1, 12);
        expect(result?.runners[2]?.horseName).toBe("穴馬");
    });

    test("flags a long shot that the model rates highly and leaves the favorites alone", () => {
        const target = race(jraRaceId(1), TODAY, [
            runner(1, { odds: 2, popularity: 1, age: 4 }),
            runner(2, { odds: 3, popularity: 2, age: 4 }),
            runner(3, { odds: 5, popularity: 3, age: 4 }),
            runner(4, { odds: 8, popularity: 4, age: 4 }),
            runner(5, { odds: 12, popularity: 5, age: 4 }),
            runner(6, { odds: 20, popularity: 6, age: 9 }),
        ]);
        const result = predictRace(
            target,
            "x",
            names,
            new HistoryState(),
            ageLovingModel(),
            DEFAULT_VALUE_CRITERIA,
            NOW,
        );
        const picks = result?.runners.filter((entry) => entry.isValuePick) ?? [];
        expect(picks.map((entry) => entry.horseNumber)).toEqual([6]);
        expect(picks[0]?.modelRank).toBe(1);
        expect(picks[0]?.expectedValue).toBeGreaterThanOrEqual(1);
        expect(picks[0]?.modelProbability).toBeGreaterThan(picks[0]?.marketProbability ?? 1);
    });

    test("does not read a result of the same day (leak guard)", () => {
        const state = new HistoryState();
        state.applyRace(race(jraRaceId(9), TODAY, [runner(1), runner(2)]));
        const target = race(jraRaceId(1), TODAY, [runner(1), runner(2)]);
        expect(() => predictRace(target, "x", names, state, ageLovingModel(), DEFAULT_VALUE_CRITERIA, NOW)).toThrow(
            RangeError,
        );
    });
});

describe("predictToday", () => {
    let db: TestDatabase;
    let close: () => Promise<void>;
    let crud: SkylarkCrud;
    let repository: PredictionRepository;

    beforeAll(async () => {
        const created = await createTestDatabase();
        db = created.db;
        close = created.close;
        crud = new SkylarkCrud(db, createRecordingLogger());
        repository = new PredictionRepository(db);
    });

    afterAll(async () => {
        await close();
    });

    beforeEach(async () => {
        await crud.truncateAllTables();
        await db.execute(sql`TRUNCATE TABLE prediction_tbl, prediction_model_tbl RESTART IDENTITY CASCADE`);
        await crud.insertHorses([
            { id: 5001, horseName: "馬1" },
            { id: 5002, horseName: "馬2" },
        ]);
    });

    async function seedHistory(date: string, raceId: number): Promise<void> {
        await crud.insertRaceInfo({
            id: raceId,
            raceName: "過去",
            date,
            distance: 1600,
            trackSurface: "芝",
            raceNumber: 1,
            placeDetail: "東京",
        });
        await crud.insertRaceResults([
            resultRecord(raceId, 1, { horseId: 5001, orderOfFinish: 1, odds: 2.5, popularity: 1 }),
            resultRecord(raceId, 2, { horseId: 5002, orderOfFinish: 2, odds: 5, popularity: 2 }),
        ]);
    }

    async function seedModel(): Promise<number> {
        return repository.insertModel({
            circuit: "jra",
            trainFrom: "2025-04-05",
            validFrom: "2026-03-27",
            testFrom: "2026-07-05",
            dataTo: "2026-10-12",
            parameters: ageLovingModel(),
            metrics: {},
        });
    }

    const longShotHorses = [
        horseEntry(1, { odds: 2, popularity: 1 }),
        horseEntry(2, { odds: 3, popularity: 2 }),
        horseEntry(3, { odds: 5, popularity: 3 }),
        horseEntry(4, { odds: 8, popularity: 4 }),
        horseEntry(5, { odds: 12, popularity: 5 }),
        horseEntry(6, { odds: 20, popularity: 6, barei: "牡9" }),
    ];

    function dependencies(client: NetkeibaClient) {
        const logger = createRecordingLogger();
        return { logger, deps: { client, repository, logger, now: () => NOW } };
    }

    const options = { criteria: DEFAULT_VALUE_CRITERIA, historySince: "2025-01-01", raceIds: [] as number[] };

    test("predicts today's central races only, skips unsold ones, and saves the snapshot to PostgreSQL", async () => {
        const modelId = await seedModel();
        await seedHistory("2026-10-17", jraRaceId(100));
        const preSale = information(
            jraRaceId(2),
            [horseEntry(1, { odds: null, popularity: null }), horseEntry(2, { odds: null, popularity: null })],
            "発売前",
        );
        const client = fakeClient({
            list: [listItem(jraRaceId(1), "本日のS"), listItem(jraRaceId(2), "発売前"), listItem(202630050101, "地方")],
            informations: [information(jraRaceId(1), longShotHorses, "本日のS"), preSale],
        });
        const { deps, logger } = dependencies(client);

        const result = await predictToday(deps, options);

        expect(result).toMatchObject({ date: TODAY, modelId, skippedRaceIds: [jraRaceId(2)] });
        expect(result.predictions[0]).toMatchObject({ raceName: "東京1R 本日のS", postTime: "15:20" });
        expect(result.predictions.map((prediction) => prediction.raceId)).toEqual([jraRaceId(1)]);
        expect(
            result.predictions[0]?.runners.filter((entry) => entry.isValuePick).map((entry) => entry.horseNumber),
        ).toEqual([6]);
        expect(logger.ofLevel("warning").some((message) => message.includes("no win odds"))).toBe(true);

        const saved = await repository.listPredictionsWithResults(TODAY);
        expect(saved).toHaveLength(6);
        expect(saved.every((row) => row.modelId === modelId && !row.hasResult)).toBe(true);
        expect(saved.filter((row) => row.isValuePick).map((row) => row.horseNumber)).toEqual([6]);
        expect(saved.find((row) => row.horseNumber === 6)?.capturedAt.getTime()).toBe(NOW.getTime());
        // 保存するレース名にも会場とレース番号を付ける(--report で見分けられるように)
        expect(saved.every((row) => row.raceName === "東京1R 本日のS")).toBe(true);
    });

    test("never reads results dated today, even if they are already in the database", async () => {
        await seedModel();
        await seedHistory("2026-10-17", jraRaceId(100));
        await seedHistory(TODAY, jraRaceId(101));
        const client = fakeClient({
            list: [listItem(jraRaceId(1), "本日のS")],
            informations: [information(jraRaceId(1), longShotHorses)],
        });
        const { deps, logger } = dependencies(client);

        await predictToday(deps, options);

        expect(logger.ofLevel("info").some((message) => message.includes("1 races up to 2026-10-17"))).toBe(true);
    });

    test("predicts only the requested race ids and warns about ids that are not held today", async () => {
        await seedModel();
        await seedHistory("2026-10-17", jraRaceId(100));
        const client = fakeClient({
            list: [listItem(jraRaceId(1), "A"), listItem(jraRaceId(3), "B")],
            informations: [information(jraRaceId(1), longShotHorses), information(jraRaceId(3), longShotHorses)],
        });
        const { deps, logger } = dependencies(client);

        const result = await predictToday(deps, { ...options, raceIds: [jraRaceId(3), 999] });

        expect(result.predictions.map((prediction) => prediction.raceId)).toEqual([jraRaceId(3)]);
        expect(logger.ofLevel("warning").some((message) => message.includes("race 999"))).toBe(true);
    });

    test("keeps going when one race fails to load and reports it as skipped", async () => {
        await seedModel();
        await seedHistory("2026-10-17", jraRaceId(100));
        const client = fakeClient({
            list: [listItem(jraRaceId(1), "A"), listItem(jraRaceId(3), "B")],
            informations: [information(jraRaceId(3), longShotHorses)],
            failFor: [jraRaceId(1)],
        });
        const { deps, logger } = dependencies(client);

        const result = await predictToday(deps, options);

        expect(result.predictions.map((prediction) => prediction.raceId)).toEqual([jraRaceId(3)]);
        expect(result.skippedRaceIds).toEqual([jraRaceId(1)]);
        expect(logger.ofLevel("error").length).toBe(1);
    });

    test("warns when yesterday's results have not been imported", async () => {
        await seedModel();
        await seedHistory("2026-10-15", jraRaceId(100));
        const client = fakeClient({ list: [], informations: [] });
        const { deps, logger } = dependencies(client);

        await predictToday(deps, options);

        expect(logger.ofLevel("warning").some((message) => message.includes("2026-10-15"))).toBe(true);
    });

    test("fails clearly without a trained model, without history, or without races today", async () => {
        const client = fakeClient({ list: [listItem(jraRaceId(1), "A")], informations: [] });
        await expect(predictToday(dependencies(client).deps, options)).rejects.toThrow(/--train/);

        await seedModel();
        await expect(predictToday(dependencies(client).deps, options)).rejects.toThrow(/-U -S/);

        await seedHistory("2026-10-17", jraRaceId(100));
        const noRaceToday = fakeClient({ dates: [{ text: "10/25", href: "x", kaisaiDate: "2026-10-25" }] });
        await expect(predictToday(dependencies(noRaceToday).deps, options)).rejects.toThrow(/no races are held/);
    });
});

describe("reports", () => {
    const prediction = predictRace(
        race(jraRaceId(1), TODAY, [
            runner(1, { odds: 2, popularity: 1, age: 4 }),
            runner(2, { odds: 3, popularity: 2, age: 4 }),
            runner(3, { odds: 5, popularity: 3, age: 4 }),
            runner(4, { odds: 8, popularity: 4, age: 4 }),
            runner(5, { odds: 12, popularity: 5, age: 4 }),
            runner(6, { odds: 20, popularity: 6, age: 9 }),
        ]),
        "テストS",
        new Map([[6, "穴馬"]]),
        new HistoryState(),
        ageLovingModel(),
        DEFAULT_VALUE_CRITERIA,
        NOW,
        "15:20",
    );

    test("lists the picks first and marks them in the race table", () => {
        if (prediction == null) {
            throw new Error("no prediction");
        }
        const text = formatPredictions(
            { date: TODAY, modelId: 1, predictions: [prediction], skippedRaceIds: [] },
            DEFAULT_VALUE_CRITERIA,
            false,
        );
        expect(text).toContain("★ 条件を満たす馬 1頭");
        expect(text).toContain("15:20発走");
        expect(text).toContain("穴馬");
        expect(text).toContain("オッズ 10倍以上 かつ 人気 4位以下 かつ モデル勝率 5位以内");
        expect(text.split("\n").some((line) => line.startsWith("★ ") && line.includes("穴馬"))).toBe(true);
    });

    test("says so when no horse meets the conditions", () => {
        const text = formatPredictions(
            { date: TODAY, modelId: 1, predictions: [], skippedRaceIds: [5] },
            DEFAULT_VALUE_CRITERIA,
            false,
        );
        expect(text).toContain("条件を満たす馬はいません");
        expect(text).toContain("予測できなかったレース: 5");
    });

    test("converts a prediction to rows keyed by race and horse", () => {
        if (prediction == null) {
            throw new Error("no prediction");
        }
        const rows = toPredictionRecords(prediction, 7);
        expect(rows).toHaveLength(6);
        expect(new Set(rows.map((row) => `${row.raceId}:${row.horseNumber}`)).size).toBe(6);
        expect(rows.every((row) => row.modelId === 7 && row.capturedAt === NOW)).toBe(true);
    });

    test("verification reports the result of each pick and the return rate of the settled ones", () => {
        const base = {
            modelId: 1,
            raceId: 1,
            capturedAt: NOW,
            raceName: "テストS",
            horseName: "穴馬",
            odds: 20,
            popularity: 6,
            marketProbability: 0.04,
            modelProbability: 0.08,
            modelRank: 2,
            expectedValue: 1.6,
            isValuePick: true,
        };
        const text = formatVerification(TODAY, [
            { ...base, horseNumber: 6, orderOfFinish: 1, hasResult: true, winPayoff: 2000 },
            { ...base, horseNumber: 7, orderOfFinish: 5, hasResult: true, winPayoff: null },
            { ...base, raceId: 2, horseNumber: 1, orderOfFinish: null, hasResult: false, winPayoff: null },
        ]);
        expect(text).toContain("1着 払戻2000円");
        expect(text).toContain("5着");
        expect(text).toContain("結果未取り込み");
        // 結果が出た2頭に100円ずつ 2000円の払戻 = 回収率1000%
        expect(text).toContain("回収率1000%");
        expect(formatVerification(TODAY, [])).toContain("保存済みの予測はありません");
    });

    test("training report shows the margin of error and warns that a small improvement is not an edge", () => {
        const metrics = {
            from: "2026-07-05",
            to: "2026-10-12",
            races: 972,
            meanLogLoss: { market: 1.8812, model: 1.8787 },
            top1HitRate: { market: 0.356, model: 0.355 },
            valuePicks: {
                bets: 57,
                hits: 7,
                hitRate: 0.123,
                meanOdds: 17.3,
                meanPredictedProbability: 0.075,
                returnRate: 1.44,
                returnRateStandardError: 0.52,
            },
            longshotBaseline: {
                bets: 8796,
                hits: 197,
                hitRate: 0.022,
                meanOdds: 86.1,
                meanPredictedProbability: 0.024,
                returnRate: 0.66,
                returnRateStandardError: 0.07,
            },
        };
        const text = formatTrainingReport(
            {
                parameters: ageLovingModel(),
                split: {
                    historyFrom: "2025-01-05",
                    trainFrom: "2025-04-05",
                    validFrom: "2026-03-27",
                    testFrom: "2026-07-05",
                    dataTo: "2026-10-12",
                },
                selectedL2: 100,
                l2Candidates: [{ l2: 100, validLogLoss: 1.94 }],
                races: { train: 3377, valid: 972, test: 972 },
                valid: metrics,
                test: metrics,
                criteria: DEFAULT_VALUE_CRITERIA,
            },
            1,
        );
        expect(text).toContain("モデル #1");
        // 回収率144%±52% は 100%との差が誤差の範囲
        expect(text).toContain("回収率144%±52% (100%との差は誤差の範囲)");
        // 条件だけが同じ全馬は 66%±7% で100%を大きく下回る
        expect(text).toContain("回収率66%±7%");
        expect(text).not.toContain("回収率66%±7% (100%との差は誤差の範囲)");
        expect(text).toContain("割安な馬を見つけられていません");
    });
});
