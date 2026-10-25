//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { sql } from "drizzle-orm";

import { SkylarkCrud } from "../src/db/crud.ts";
import { PredictionRepository } from "../src/db/prediction-repository.ts";
import type { BoxProposalRecord, PredictionRecord } from "../src/db/schema.ts";
import { payoutKey } from "../src/predict/evaluation.ts";
import { createRecordingLogger } from "./mock-fetch.ts";
import { createTestDatabase, resultRecord, type TestDatabase } from "./test-database.ts";

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
        { id: 1, horseName: "H1" },
        { id: 2, horseName: "H2" },
        { id: 3, horseName: "H3" },
    ]);
});

async function seedRace(raceId: number, date: string): Promise<void> {
    await crud.insertRaceInfo({
        id: raceId,
        raceName: `race ${raceId}`,
        date,
        distance: 1600,
        trackSurface: "芝",
        raceNumber: 1,
        placeDetail: "東京",
    });
}

function prediction(overrides: Partial<PredictionRecord> = {}): PredictionRecord {
    return {
        modelId: 1,
        raceId: 202605040701,
        horseNumber: 1,
        capturedAt: new Date("2026-10-18T00:00:00Z"),
        raceDate: "2026-10-18",
        raceName: "テストS",
        horseId: 1,
        horseName: "H1",
        odds: 12.5,
        popularity: 5,
        marketProbability: 0.064,
        modelProbability: 0.09,
        modelRank: 3,
        expectedValue: 1.125,
        isValuePick: true,
        ...overrides,
    };
}

async function insertModel(): Promise<number> {
    return repository.insertModel({
        circuit: "jra",
        trainFrom: "2025-04-05",
        validFrom: "2026-03-27",
        testFrom: "2026-07-05",
        dataTo: "2026-10-12",
        parameters: { version: 1, coefficients: [0.1, -0.2] },
        metrics: { test: { races: 10 } },
    });
}

describe("loadRaceRecords", () => {
    test("groups the rows by race and keeps the scratched horses with null odds", async () => {
        await seedRace(202605040701, "2026-02-01");
        await seedRace(202605040702, "2026-02-08");
        await crud.insertRaceResults([
            resultRecord(202605040701, 1, { horseId: 1, orderOfFinish: 1, odds: 3.2, popularity: 1 }),
            resultRecord(202605040701, 2, { horseId: 2, orderOfFinish: null, odds: null, popularity: null }),
            resultRecord(202605040702, 1, {
                horseId: 3,
                orderOfFinish: 2,
                odds: 8.8,
                popularity: 3,
                jockeyId: "01234",
            }),
        ]);

        const races = await repository.loadRaceRecords("2026-01-01");

        expect(races.map((race) => race.raceId)).toEqual([202605040701, 202605040702]);
        expect(races[0]).toMatchObject({ date: "2026-02-01", distance: 1600, trackSurface: "芝" });
        expect(races[0]?.runners.map((runner) => [runner.horseNumber, runner.odds])).toEqual([
            [1, 3.2],
            [2, null],
        ]);
        // 先頭の0を保つ
        expect(races[1]?.runners[0]?.jockeyId).toBe("01234");
    });

    test("excludes races before the start date and from the end date on", async () => {
        await seedRace(202605040701, "2026-01-31");
        await seedRace(202605040702, "2026-02-01");
        await seedRace(202605040703, "2026-02-08");
        await crud.insertRaceResults([
            resultRecord(202605040701, 1),
            resultRecord(202605040702, 1),
            resultRecord(202605040703, 1),
        ]);

        const races = await repository.loadRaceRecords("2026-02-01", "2026-02-08");

        // 当日(終了日)の結果は含めない
        expect(races.map((race) => race.raceId)).toEqual([202605040702]);
    });
});

describe("loadWinPayouts", () => {
    test("reads only win tickets, by race and horse number", async () => {
        await seedRace(202605040701, "2026-02-01");
        await seedRace(202605040702, "2025-12-31");
        await crud.insertPayoffs([
            { raceId: 202605040701, ticketType: 0, horseNumbers: "3", payoff: 1230, popularity: 4 },
            { raceId: 202605040701, ticketType: 1, horseNumbers: "3", payoff: 310, popularity: 4 },
            { raceId: 202605040701, ticketType: 4, horseNumbers: "3-5", payoff: 5400, popularity: 9 },
            { raceId: 202605040702, ticketType: 0, horseNumbers: "1", payoff: 500, popularity: 1 },
        ]);

        const payouts = await repository.loadWinPayouts("2026-01-01");

        expect([...payouts.entries()]).toEqual([[payoutKey(202605040701, 3), 1230]]);
    });
});

describe("models", () => {
    test("stores the parameters as jsonb objects, not as an encoded string, and returns the latest", async () => {
        const first = await insertModel();
        const second = await repository.insertModel({
            circuit: "jra",
            trainFrom: "2025-04-05",
            validFrom: "2026-04-01",
            testFrom: "2026-07-10",
            dataTo: "2026-10-18",
            parameters: { version: 1, coefficients: [0.3] },
            metrics: {},
        });
        expect(second).toBeGreaterThan(first);

        const latest = await repository.getLatestModel("jra");
        expect(latest?.id).toBe(second);
        expect(latest?.parametersJson).toEqual({ version: 1, coefficients: [0.3] });
        expect(latest?.dataTo).toBe("2026-10-18");
        expect(await repository.getLatestModel("local")).toBeUndefined();
    });
});

describe("predictions", () => {
    test("returns only the latest snapshot of each race, joined with the result and the win payoff", async () => {
        const modelId = await insertModel();
        await seedRace(202605040701, "2026-10-18");
        await crud.insertRaceResults([
            resultRecord(202605040701, 1, { horseId: 1, orderOfFinish: 1 }),
            resultRecord(202605040701, 2, { horseId: 2, orderOfFinish: 2 }),
        ]);
        await crud.insertPayoffs([
            { raceId: 202605040701, ticketType: 0, horseNumbers: "1", payoff: 1250, popularity: 5 },
        ]);

        const older = new Date("2026-10-18T00:00:00Z");
        const newer = new Date("2026-10-18T05:00:00Z");
        await repository.insertPredictions([
            prediction({ modelId, capturedAt: older, odds: 99 }),
            prediction({ modelId, capturedAt: newer, odds: 12.5 }),
            prediction({ modelId, capturedAt: newer, horseNumber: 2, horseId: 2, horseName: "H2", isValuePick: false }),
            // 結果がまだ無いレース
            prediction({ modelId, capturedAt: newer, raceId: 202605040702, horseNumber: 1 }),
        ]);

        const rows = await repository.listPredictionsWithResults("2026-10-18");

        expect(rows.map((row) => [row.raceId, row.horseNumber, row.odds])).toEqual([
            [202605040701, 1, 12.5],
            [202605040701, 2, 12.5],
            [202605040702, 1, 12.5],
        ]);
        expect(rows[0]).toMatchObject({ orderOfFinish: 1, hasResult: true, winPayoff: 1250, isValuePick: true });
        expect(rows[1]).toMatchObject({ orderOfFinish: 2, hasResult: true, winPayoff: null, isValuePick: false });
        expect(rows[2]).toMatchObject({ orderOfFinish: null, hasResult: false, winPayoff: null });
    });

    test("distinguishes a horse without a finishing order from a race whose results are not imported", async () => {
        const modelId = await insertModel();
        await seedRace(202605040701, "2026-10-18");
        await crud.insertRaceResults([resultRecord(202605040701, 1, { horseId: 1, orderOfFinish: null })]);
        await repository.insertPredictions([prediction({ modelId })]);

        const [row] = await repository.listPredictionsWithResults("2026-10-18");

        expect(row).toMatchObject({ orderOfFinish: null, hasResult: true });
    });

    test("ignores other dates and accepts an empty batch", async () => {
        const modelId = await insertModel();
        await repository.insertPredictions([]);
        await repository.insertPredictions([prediction({ modelId, raceDate: "2026-10-11" })]);
        expect(await repository.listPredictionsWithResults("2026-10-18")).toEqual([]);
    });

    test("is not removed by truncateAllTables, because the odds at capture time cannot be recovered", async () => {
        const modelId = await insertModel();
        await repository.insertPredictions([prediction({ modelId })]);

        await crud.truncateAllTables();

        expect(await repository.listPredictionsWithResults("2026-10-18")).toHaveLength(1);
        expect((await repository.getLatestModel("jra"))?.id).toBe(modelId);
    });
});

function boxProposal(overrides: Partial<BoxProposalRecord> = {}): BoxProposalRecord {
    return {
        modelId: 1,
        raceId: 202605040701,
        capturedAt: new Date("2026-10-18T05:00:00Z"),
        raceDate: "2026-10-18",
        raceName: "テストS",
        source: "ai",
        aiModel: "claude-opus-5-5",
        maxTickets: 60,
        horseNumbers: "1-2-3-4",
        ticketCount: 24,
        hitProbability: 0.31,
        bestHitProbability: 0.31,
        baselineHorseNumbers: "1-2-3-4-5",
        baselineHitProbability: 0.44,
        reason: "上位4頭",
        caution: null,
        ...overrides,
    };
}

describe("box proposals", () => {
    test("returns only the latest proposal of each race, joined with the result and the trifecta payoff", async () => {
        const modelId = await insertModel();
        await seedRace(202605040701, "2026-10-18");
        await crud.insertRaceResults([
            resultRecord(202605040701, 3, { horseId: 1, orderOfFinish: 1 }),
            resultRecord(202605040701, 1, { horseId: 2, orderOfFinish: 2 }),
            resultRecord(202605040701, 2, { horseId: 3, orderOfFinish: 3 }),
        ]);
        await crud.insertPayoffs([
            // 単勝と三連複は三連単として数えない
            { raceId: 202605040701, ticketType: 0, horseNumbers: "3", payoff: 350, popularity: 2 },
            { raceId: 202605040701, ticketType: 7, horseNumbers: "1-2-3", payoff: 2400, popularity: 5 },
            { raceId: 202605040701, ticketType: 8, horseNumbers: "3->1->2", payoff: 15230, popularity: 20 },
        ]);
        await repository.insertBoxProposal(boxProposal({ modelId, horseNumbers: "1-2-5-6", ticketCount: 24 }));
        await repository.insertBoxProposal(boxProposal({ modelId, horseNumbers: "1-2-3-4", ticketCount: 24 }));
        // 結果がまだ無いレース
        await repository.insertBoxProposal(
            boxProposal({ modelId, raceId: 202605040702, source: "fallback", aiModel: null, caution: "注意" }),
        );

        const rows = await repository.listBoxProposalsWithResults("2026-10-18");

        expect(rows.map((row) => [row.raceId, row.horseNumbers])).toEqual([
            [202605040701, [1, 2, 3, 4]],
            [202605040702, [1, 2, 3, 4]],
        ]);
        expect(rows[0]).toMatchObject({
            modelId,
            source: "ai",
            aiModel: "claude-opus-5-5",
            ticketCount: 24,
            hitProbability: 0.31,
            baselineHorseNumbers: [1, 2, 3, 4, 5],
            baselineHitProbability: 0.44,
            hasResult: true,
            winningTickets: [{ horseNumbers: [3, 1, 2], payoff: 15230 }],
        });
        expect(rows[1]).toMatchObject({
            source: "fallback",
            aiModel: null,
            caution: "注意",
            hasResult: false,
            winningTickets: [],
        });
    });

    test("returns every winning combination of a dead heat", async () => {
        const modelId = await insertModel();
        await seedRace(202605040701, "2026-10-18");
        await crud.insertRaceResults([resultRecord(202605040701, 1, { horseId: 1, orderOfFinish: 1 })]);
        await crud.insertPayoffs([
            { raceId: 202605040701, ticketType: 8, horseNumbers: "1->2->3", payoff: 5000, popularity: 9 },
            { raceId: 202605040701, ticketType: 8, horseNumbers: "1->3->2", payoff: 5100, popularity: 10 },
        ]);
        await repository.insertBoxProposal(boxProposal({ modelId }));

        const [row] = await repository.listBoxProposalsWithResults("2026-10-18");

        expect(row?.winningTickets.map((ticket) => ticket.payoff).sort()).toEqual([5000, 5100]);
    });

    test("keeps a race with imported results but no trifecta payoff, such as a cancelled race", async () => {
        const modelId = await insertModel();
        await seedRace(202605040701, "2026-10-18");
        await crud.insertRaceResults([resultRecord(202605040701, 1, { horseId: 1, orderOfFinish: null })]);
        await repository.insertBoxProposal(boxProposal({ modelId }));

        const [row] = await repository.listBoxProposalsWithResults("2026-10-18");

        expect(row).toMatchObject({ hasResult: true, winningTickets: [] });
    });

    test("ignores other dates, and skips a row whose horse numbers cannot be read", async () => {
        const modelId = await insertModel();
        expect(await repository.listBoxProposalsWithResults("2026-10-18")).toEqual([]);
        await repository.insertBoxProposal(boxProposal({ modelId, raceDate: "2026-10-11" }));
        await repository.insertBoxProposal(boxProposal({ modelId, raceId: 202605040703, horseNumbers: "1-x-3" }));
        await repository.insertBoxProposal(boxProposal({ modelId, raceId: 202605040704 }));

        const rows = await repository.listBoxProposalsWithResults("2026-10-18");

        expect(rows.map((row) => row.raceId)).toEqual([202605040704]);
    });

    test("is not removed by truncateAllTables, because the proposal cannot be reproduced", async () => {
        const modelId = await insertModel();
        await repository.insertBoxProposal(boxProposal({ modelId }));

        await crud.truncateAllTables();

        expect(await repository.listBoxProposalsWithResults("2026-10-18")).toHaveLength(1);
    });
});
