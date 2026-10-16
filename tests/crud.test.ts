//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { sql } from "drizzle-orm";

import { SkylarkCrud } from "../src/db/crud.ts";
import type { Logger } from "../src/logger.ts";
import { createTestDatabase, resultRecord, type TestDatabase } from "./test-database.ts";

type RecordingLogger = Logger & { errors: string[] };

function createRecordingLogger(): RecordingLogger {
    const errors: string[] = [];
    return {
        errors,
        debug: () => {},
        info: () => {},
        warning: () => {},
        error: (message) => {
            errors.push(message);
        },
    };
}

let db: TestDatabase;
let close: () => Promise<void>;
let crud: SkylarkCrud;
let logger: RecordingLogger;

async function seedRace(raceId: number, date: string, distance: number): Promise<void> {
    await crud.insertRaceInfo({
        id: raceId,
        raceName: `race ${raceId}`,
        date,
        postTime: "10:00",
        distance,
        raceNumber: 1,
        placeDetail: "札幌",
    });
}

beforeAll(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    logger = createRecordingLogger();
    crud = new SkylarkCrud(db, logger);
});

afterAll(async () => {
    await close();
});

// 各テストの前に全テーブルを空にする(DBの作成は遅いので全体で1回だけ)
beforeEach(async () => {
    await crud.truncateAllTables();
    logger.errors.length = 0;
    await crud.insertHorses([
        { id: 1, horseName: "H1" },
        { id: 2, horseName: "H2" },
    ]);
});

describe("insert methods", () => {
    test("ignore duplicates and keep the first row like the original get-then-add", async () => {
        await crud.insertHorses([
            { id: 10, horseName: "first" },
            { id: 10, horseName: "second" },
        ]);
        await crud.insertHorses([{ id: 10, horseName: "third" }]);
        expect((await crud.getHorse(10))?.horseName).toBe("first");
    });

    test("accept empty lists", async () => {
        await crud.insertHorses([]);
        await crud.insertJockeys([]);
        await crud.insertTrainers([]);
        await crud.insertOwners([]);
        await crud.insertRaceResults([]);
        await crud.insertPayoffs([]);
        await crud.upsertFeatures([]);
    });

    test("insert and read master records with leading zero ids", async () => {
        await crud.insertJockeys([{ id: "01102", jockeyName: "J" }]);
        await crud.insertTrainers([{ id: "00012", trainerName: "T" }]);
        await crud.insertOwners([{ id: "000123", ownerName: "O" }]);
        expect((await crud.getJockey("01102"))?.jockeyName).toBe("J");
        expect((await crud.getTrainer("00012"))?.trainerName).toBe("T");
        expect((await crud.getOwner("000123"))?.ownerName).toBe("O");
        expect(await crud.getJockey("1102")).toBeUndefined();
    });

    test("race info keeps the first row and round trips date and time", async () => {
        await seedRace(100, "2024-01-05", 1200);
        await crud.insertRaceInfo({
            id: 100,
            raceName: "changed",
            date: "2030-01-01",
            raceNumber: 9,
            placeDetail: "x",
        });
        const info = await crud.getRaceInfo(100);
        expect(info).toMatchObject({ raceName: "race 100", date: "2024-01-05", distance: 1200 });
        expect(info?.postTime).toBe("10:00:00");
    });

    test("race results keep fractional seconds that MySQL TIME dropped", async () => {
        await seedRace(100, "2024-01-05", 1200);
        await crud.insertRaceResults([resultRecord(100, 1, { finishingTime: "00:01:10.5" })]);
        expect((await crud.getRaceResult(100, 1))?.finishingTime).toBe("00:01:10.5");
    });

    test("reject results whose horse does not exist because foreign keys are enforced", async () => {
        await seedRace(100, "2024-01-05", 1200);
        await expect(crud.insertRaceResults([resultRecord(100, 1, { horseId: 999 })])).rejects.toThrow();
    });

    test("payoffs ignore duplicates of the primary key", async () => {
        await seedRace(100, "2024-01-05", 1200);
        const payoff = { raceId: 100, ticketType: 1, horseNumbers: "3", payoff: 130, popularity: 2 };
        await crud.insertPayoffs([payoff, { ...payoff, payoff: 999 }]);
        await crud.insertPayoffs([{ ...payoff, payoff: 777 }]);
        const rows = await db.execute(sql`select payoff from payoff_tbl where race_id = 100`);
        expect(rows.rows).toEqual([{ payoff: 130 }]);
    });
});

describe("lookup methods", () => {
    beforeEach(async () => {
        await seedRace(100, "2024-01-05", 1200);
        await crud.insertJockeys([{ id: "J1", jockeyName: "j" }]);
        await crud.insertTrainers([{ id: "T1", trainerName: "t" }]);
        await crud.insertOwners([{ id: "O1", ownerName: "o" }]);
        await crud.insertRaceResults([
            resultRecord(100, 2, { horseId: 2, jockeyId: "J1", trainerId: "T1", ownerId: "O1", orderOfFinish: null }),
            resultRecord(100, 1, { horseId: 1 }),
        ]);
    });

    test("return ids of a starter", async () => {
        expect(await crud.getHorseId(100, 2)).toBe(2);
        expect(await crud.getJockeyId(100, 2)).toBe("J1");
        expect(await crud.getTrainerId(100, 2)).toBe("T1");
        expect(await crud.getOwnerId(100, 2)).toBe("O1");
        expect(await crud.getOrderOfFinish(100, 2)).toBeNull();
        expect(await crud.getOrderOfFinish(100, 1)).toBe(1);
    });

    test("return undefined for unknown keys", async () => {
        expect(await crud.getHorseId(100, 9)).toBeUndefined();
        expect(await crud.getHorse(12345)).toBeUndefined();
        expect(await crud.getRaceInfo(12345)).toBeUndefined();
        expect(await crud.getRaceResult(100, 9)).toBeUndefined();
    });

    test("list results ordered by race and horse number", async () => {
        const results = await crud.getRaceResults();
        expect(results?.map((row) => row.horseNumber)).toEqual([1, 2]);
    });

    test("reject non positive keys like the original assert", async () => {
        await expect(crud.getHorseId(0, 1)).rejects.toThrow(RangeError);
        await expect(crud.getJockeyId(1, 0)).rejects.toThrow(RangeError);
        await expect(crud.getSpeedFigureLast(0, "2024-01-01")).rejects.toThrow(RangeError);
        await expect(crud.getSpeedFigureAvg(1, "2024-01-01", 0)).rejects.toThrow(RangeError);
    });

    test("list feature targets joined with race information", async () => {
        const targets = await crud.listFeatureTargets();
        expect(targets).toEqual([
            {
                raceId: 100,
                horseNumber: 1,
                horseId: 1,
                jockeyId: "00001",
                trainerId: "00002",
                date: "2024-01-05",
                distance: 1200,
            },
            {
                raceId: 100,
                horseNumber: 2,
                horseId: 2,
                jockeyId: "J1",
                trainerId: "T1",
                date: "2024-01-05",
                distance: 1200,
            },
        ]);
    });
});

describe("read errors", () => {
    test("are logged and turned into undefined", async () => {
        const broken = await createTestDatabase();
        const brokenLogger = createRecordingLogger();
        const brokenCrud = new SkylarkCrud(broken.db, brokenLogger);
        await broken.close();
        expect(await brokenCrud.getHorse(1)).toBeUndefined();
        expect(await brokenCrud.getRaceResults()).toBeUndefined();
        expect(brokenLogger.errors.length).toBe(2);
    });
});

// 馬1の過去成績 2024-01-01(1200m 1着 指数80 賞金100) 2024-02-01(1200m 5着 指数60 賞金0) 2024-03-01(1600m 2着 指数なし 賞金50)
describe("aggregate queries", () => {
    beforeEach(async () => {
        await seedRace(1, "2024-01-01", 1200);
        await seedRace(2, "2024-02-01", 1200);
        await seedRace(3, "2024-03-01", 1600);
        await seedRace(4, "2024-04-01", 1200);
        await seedRace(5, "2024-01-15", 1200);
        await crud.insertRaceResults([
            resultRecord(1, 1, { horseId: 1, orderOfFinish: 1, speedFigure: 80, earningMoney: 100 }),
            resultRecord(2, 1, { horseId: 1, orderOfFinish: 5, speedFigure: 60, earningMoney: 0 }),
            resultRecord(3, 1, { horseId: 1, orderOfFinish: 2, speedFigure: null, earningMoney: 50 }),
            resultRecord(4, 1, { horseId: 1, orderOfFinish: 3, speedFigure: 99, earningMoney: 999 }),
            // 別の馬の成績は集計に含まれない
            resultRecord(5, 1, { horseId: 2, orderOfFinish: 1, speedFigure: 10, earningMoney: 7 }),
        ]);
    });

    const DATE = "2024-04-01";

    test("latest speed figure ignores races without a figure and the race day itself", async () => {
        expect(await crud.getSpeedFigureLast(1, DATE)).toBe(60);
        expect(await crud.getSpeedFigureLast(1, "2024-02-01")).toBe(80);
        expect(await crud.getSpeedFigureLast(1, "2024-01-01")).toBeUndefined();
    });

    test("speed figure average respects the limit", async () => {
        expect(Number(await crud.getSpeedFigureAvg(1, DATE, 5))).toBe(70);
        expect(Number(await crud.getSpeedFigureAvg(1, DATE, 1))).toBe(60);
        expect(await crud.getSpeedFigureAvg(1, "2024-01-01", 5)).toBeUndefined();
    });

    test("winner average only counts top three with a figure", async () => {
        expect(Number(await crud.getWinnerAvg(1, DATE, 5))).toBe(1);
    });

    test("same distance average only counts the distance", async () => {
        expect(Number(await crud.getDisavesr(1, DATE, 1200, 100))).toBe(70);
        expect(await crud.getDisavesr(1, DATE, 1600, 100)).toBeUndefined();
    });

    test("distance average is returned as an exact decimal string", async () => {
        expect(await crud.getDistanceAvg(1, DATE, 100)).toBe("1333.3333333333333333");
    });

    test("earnings average", async () => {
        expect(Number(await crud.getEarningsPerShare(1, DATE, 100))).toBe(50);
        expect(Number(await crud.getEarningsPerShare(1, DATE, 2))).toBe(25);
    });
});

describe("upsertFeatures", () => {
    beforeEach(async () => {
        await seedRace(100, "2024-01-05", 1200);
    });

    test("inserts, updates by primary key and keeps the last duplicate in a batch", async () => {
        await crud.upsertFeatures([
            { horseId: 1, raceId: 100, jockeyId: "a", trainerId: "b", calculationResultJson: { v: 1 } },
            { horseId: 1, raceId: 100, jockeyId: "a", trainerId: "b", calculationResultJson: { v: 2 } },
        ]);
        let rows = await db.execute(sql`select jockey_id, calculation_result_json as j from feature_tbl`);
        expect(rows.rows).toEqual([{ jockey_id: "a", j: { v: 2 } }]);

        await crud.upsertFeatures([
            { horseId: 1, raceId: 100, jockeyId: "z", trainerId: "y", calculationResultJson: { v: 3 } },
        ]);
        rows = await db.execute(sql`select jockey_id, trainer_id, calculation_result_json as j from feature_tbl`);
        expect(rows.rows).toEqual([{ jockey_id: "z", trainer_id: "y", j: { v: 3 } }]);
    });

    test("stores the result as a jsonb object and not as a JSON string", async () => {
        await crud.upsertFeatures([
            { horseId: 1, raceId: 100, jockeyId: "a", trainerId: "b", calculationResultJson: { list: [1, 2] } },
        ]);
        const rows = await db.execute(sql`select jsonb_typeof(calculation_result_json) as t from feature_tbl`);
        expect(rows.rows).toEqual([{ t: "object" }]);
    });

    test("accepts a null result", async () => {
        await crud.upsertFeatures([
            { horseId: 1, raceId: 100, jockeyId: "a", trainerId: "b", calculationResultJson: null },
        ]);
        const rows = await db.execute(sql`select calculation_result_json as j from feature_tbl`);
        expect(rows.rows).toEqual([{ j: null }]);
    });
});

describe("truncate", () => {
    test("truncateAllTables empties every table but keeps the schema", async () => {
        await seedRace(100, "2024-01-05", 1200);
        await crud.insertRaceResults([resultRecord(100, 1)]);
        await crud.truncateAllTables();
        const rows = await db.execute(
            sql`select (select count(*) from race_info_tbl)::int a, (select count(*) from horse_tbl)::int b, (select count(*) from race_result_tbl)::int c`,
        );
        expect(rows.rows).toEqual([{ a: 0, b: 0, c: 0 }]);
        await seedRace(100, "2024-01-05", 1200);
        expect(await crud.getRaceInfo(100)).toBeDefined();
    });

    test("truncateTable only empties the named table", async () => {
        await seedRace(100, "2024-01-05", 1200);
        await crud.upsertFeatures([
            { horseId: 1, raceId: 100, jockeyId: "a", trainerId: "b", calculationResultJson: {} },
        ]);
        await crud.truncateTable("feature_tbl");
        const rows = await db.execute(
            sql`select (select count(*) from feature_tbl)::int f, (select count(*) from race_info_tbl)::int r`,
        );
        expect(rows.rows).toEqual([{ f: 0, r: 1 }]);
    });
});
