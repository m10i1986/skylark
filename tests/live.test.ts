//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { sql } from "drizzle-orm";

import { SkylarkCrud } from "../src/db/crud.ts";
import { PredictionRepository } from "../src/db/prediction-repository.ts";
import type { BoxProposal } from "../src/predict/ai-box.ts";
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
import {
    formatBoxProposals,
    formatBoxVerification,
    formatPredictions,
    formatTrainingReport,
    formatVerification,
} from "../src/predict/report.ts";
import type { TrainingResult } from "../src/predict/train.ts";
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
        // 予測できたレースの出馬表だけを返す(発売前で読み飛ばしたレースは含まない)
        expect([...result.informations.keys()]).toEqual([jraRaceId(1)]);
        expect(result.informations.get(jraRaceId(1))?.horses).toHaveLength(longShotHorses.length);
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
            { date: TODAY, modelId: 1, predictions: [prediction], skippedRaceIds: [], informations: new Map() },
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
            { date: TODAY, modelId: 1, predictions: [], skippedRaceIds: [5], informations: new Map() },
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

    test("verification tells which snapshot is used and lists the races left out because they were predicted only after the post time", () => {
        const row = {
            modelId: 1,
            raceId: 1,
            horseNumber: 6,
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
            orderOfFinish: 1,
            hasResult: true,
            winPayoff: 2000,
        };
        const excluded = [
            { raceId: 2, raceName: "A" },
            { raceId: 3, raceName: "B" },
            { raceId: 4, raceName: "C" },
            { raceId: 5, raceName: "D" },
            { raceId: 6, raceName: "E" },
            { raceId: 7, raceName: "F" },
            { raceId: 8, raceName: "G" },
        ];

        const text = formatVerification(TODAY, [row], excluded);

        expect(text).toContain("発走前に最後に取得した分");
        // 名前を出すのは先頭の5件まで 残りは件数にする
        expect(text).toContain("検証から除外したレース: 7 (A、B、C、D、E ほか2レース)");
        // 除外が無い日は何も足さない
        expect(formatVerification(TODAY, [row])).not.toContain("除外");
    });

    test("verification does not say there is no prediction when every prediction was made after the post time", () => {
        const text = formatVerification(TODAY, [], [{ raceId: 2, raceName: "後だけS" }]);

        expect(text).toContain("発走前に取得した予測はありません");
        expect(text).toContain("後だけS");
        expect(text).not.toContain("-P で予測してください");
    });

    test("box proposals show the past result of the same box size next to the hit probability", () => {
        const proposalOf = (baseRate: BoxProposal["baseRate"]): BoxProposal => ({
            raceId: jraRaceId(1),
            raceName: "東京1R テストS",
            raceDate: TODAY,
            postTime: "15:20",
            capturedAt: NOW,
            horseNumbers: [1, 2, 3, 4],
            horses: [],
            ticketCount: 24,
            costYen: 2400,
            hitProbability: 0.2817,
            bestHitProbability: 0.2817,
            baseline: { horseNumbers: [1, 2, 3, 4, 5], ticketCount: 60, costYen: 6000, hitProbability: 0.389 },
            baseRate,
            maxTickets: 60,
            source: "ai",
            reason: "理由",
            caution: null,
            aiModel: "claude-opus-5-5",
        });
        const baseRate = {
            condition: "芝 16頭以上",
            races: 3498,
            topPopularityBoxes: [
                { horses: 3, harvilleHitRate: 0.103, actualHitRate: 0.068 },
                { horses: 4, harvilleHitRate: 0.237, actualHitRate: 0.174 },
            ],
            averageTopThreeByPopularity: {
                popularity1to3: 1.5,
                popularity4to6: 0.8,
                popularity7to9: 0.4,
                popularity10OrLower: 0.3,
            },
            longshotInTopThreeRate: 0.52,
        };

        const withRate = formatBoxProposals({
            date: TODAY,
            proposals: [proposalOf(baseRate)],
            skippedRaceIds: [],
            maxTickets: 60,
        });
        expect(withRate).toContain(
            "過去の実績: 芝 16頭以上の3,498レースで、人気上位4頭のBoxの的中率は17.4%(Harville式では23.7%) 3着以内に人気7位以下が入った割合52%",
        );
        expect(withRate).toContain("実際より高く出ます");

        const withoutRate = formatBoxProposals({
            date: TODAY,
            proposals: [proposalOf(null)],
            skippedRaceIds: [],
            maxTickets: 60,
        });
        expect(withoutRate).not.toContain("過去の実績:");
    });

    test("box verification stays silent without proposals and reports the races left out", () => {
        expect(formatBoxVerification(TODAY, [])).toBe("");

        const text = formatBoxVerification(TODAY, [], [{ raceId: 2, raceName: "後だけS" }]);

        expect(text).toContain("発走前の3連単Boxの提案はありません");
        expect(text).toContain("後だけS");
    });

    test("training report shows the margin of error and warns that a small improvement is not an edge", () => {
        const metrics = {
            from: "2026-07-05",
            to: "2026-10-12",
            races: 972,
            meanLogLoss: { market: 1.8812, model: 1.8787 },
            // 改善0.0025は標準誤差0.0030の2倍に届かない
            improvement: { mean: 0.0025, standardError: 0.003 },
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
        const block = (from: string, to: string, races: number, mean: number, standardError: number) => ({
            ...metrics,
            from,
            to,
            races,
            improvement: { mean, standardError },
        });
        const devBlocks = [
            block("2026-03-05", "2026-05-04", 600, 0.0024, 0.0025),
            block("2026-05-05", "2026-07-04", 1564, 0.0106, 0.0035),
            block("2026-07-05", "2026-07-06", 5, -0.0123, 0.0021),
        ];
        const result: TrainingResult = {
            parameters: ageLovingModel(),
            split: {
                historyFrom: "2025-01-05",
                trainFrom: "2025-04-05",
                validFrom: "2025-09-03",
                testFrom: "2026-07-05",
                dataTo: "2026-10-12",
            },
            selectedL2: 1000,
            l2Candidates: [
                { l2: 100, devLogLoss: 1.9365 },
                { l2: 1000, devLogLoss: 1.9355 },
            ],
            races: { train: 1511, dev: 2838, test: 972, all: 5321 },
            dev: {
                ...metrics,
                from: "2025-09-03",
                to: "2026-07-04",
                races: 2838,
                improvement: { mean: 0.0043, standardError: 0.0015 },
            },
            devBlocks,
            test: metrics,
            criteria: DEFAULT_VALUE_CRITERIA,
        };
        const text = formatTrainingReport(result, 1);
        expect(text).toContain("モデル #1");
        // 回収率144%±52% は 100%との差が誤差の範囲
        expect(text).toContain("回収率144%±52% (100%との差は誤差の範囲)");
        // 条件だけが同じ全馬は 66%±7% で100%を大きく下回る
        expect(text).toContain("回収率66%±7%");
        expect(text).not.toContain("回収率66%±7% (100%との差は誤差の範囲)");
        expect(text).toContain("割安な馬を見つけられていません");

        // 対数損失の改善は 標準誤差の2倍を超えるかで 言葉を変える
        expect(text).toContain("対数損失の改善(市場 - モデル): 0.0043 ±0.0015 誤差を超えています");
        expect(text).toContain("対数損失の改善(市場 - モデル): 0.0025 ±0.0030 誤差の範囲です");
        expect(text).toContain("-0.0123 ±0.0021 市場より悪化しています");
        // 区間ごとの表 レース数の桁をそろえる
        expect(text).toContain("2026-03-05 〜 2026-05-04  600レース 0.0024 ±0.0025 誤差の範囲です");
        expect(text).toContain("2026-05-05 〜 2026-07-04 1564レース 0.0106 ±0.0035 誤差を超えています");
        // L2は開発期間の対数損失で選んだこと 保存するモデルが全期間で学習し直したものであることを示す
        expect(text).toContain("100→1.9365 1000→1.9355 → 1000 を採用");
        expect(text).toContain("全期間(5321レース)で学習し直したもの");
    });
});
