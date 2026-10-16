//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { sql } from "drizzle-orm";

import { SkylarkCrud } from "../src/db/crud.ts";
import { buildFeatures, computeFeature, decimalToIntegerRatio, toRatioJson } from "../src/feature.ts";
import type { Logger } from "../src/logger.ts";
import { createTestDatabase, resultRecord, type TestDatabase } from "./test-database.ts";

// 期待値は Python の Decimal.as_integer_ratio() の実測値
describe("decimalToIntegerRatio", () => {
    test.each([
        ["1500.0000", 1500n, 1n],
        ["1333.3333", 13333333n, 10000n],
        ["0.5", 1n, 2n],
        ["-2.50", -5n, 2n],
        ["0", 0n, 1n],
        ["70.0000000000000000", 70n, 1n],
        ["0.0001000", 1n, 10000n],
        ["1333.3333333333333333", 13333333333333333333n, 10000000000000000n],
    ])("%s", (input, numerator, denominator) => {
        expect(decimalToIntegerRatio(input)).toEqual([numerator, denominator]);
    });

    test("rejects text that is not a plain decimal", () => {
        expect(() => decimalToIntegerRatio("1e3")).toThrow(SyntaxError);
        expect(() => decimalToIntegerRatio("abc")).toThrow(SyntaxError);
        expect(() => decimalToIntegerRatio("")).toThrow(SyntaxError);
    });
});

describe("toRatioJson", () => {
    test("returns null when there is no value", () => {
        expect(toRatioJson(undefined)).toBeNull();
    });

    test("emits small ratios as plain numbers", () => {
        expect(JSON.stringify(toRatioJson("1500.0000"))).toBe("[1500,1]");
    });

    test("keeps every digit of integers beyond 2^53 like Python's json.dumps", () => {
        expect(JSON.stringify(toRatioJson("1333.3333333333333333"))).toBe("[13333333333333333333,10000000000000000]");
    });
});

function createSilentLogger(): Logger & { warnings: string[] } {
    const warnings: string[] = [];
    return {
        warnings,
        debug: () => {},
        info: () => {},
        warning: (message) => {
            warnings.push(message);
        },
        error: () => {},
    };
}

let db: TestDatabase;
let close: () => Promise<void>;
let crud: SkylarkCrud;
let logger: ReturnType<typeof createSilentLogger>;

beforeAll(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    logger = createSilentLogger();
    crud = new SkylarkCrud(db, logger);
});

afterAll(async () => {
    await close();
});

beforeEach(async () => {
    await crud.truncateAllTables();
    logger.warnings.length = 0;
    await crud.insertHorses([{ id: 1, horseName: "H1" }]);
});

async function seedRace(raceId: number, date: string, distance: number): Promise<void> {
    await crud.insertRaceInfo({ id: raceId, raceName: "r", date, distance, raceNumber: 1, placeDetail: "札幌" });
}

describe("computeFeature", () => {
    test("computes every value from the races before the target race", async () => {
        await seedRace(1, "2024-01-01", 1200);
        await seedRace(2, "2024-02-01", 1200);
        await seedRace(3, "2024-03-01", 1600);
        await seedRace(4, "2024-04-01", 1200);
        await crud.insertRaceResults([
            resultRecord(1, 1, { orderOfFinish: 1, speedFigure: 80, earningMoney: 100 }),
            resultRecord(2, 1, { orderOfFinish: 5, speedFigure: 60, earningMoney: 0 }),
            resultRecord(3, 1, { orderOfFinish: 2, speedFigure: null, earningMoney: 50 }),
            resultRecord(4, 1, { orderOfFinish: 3, speedFigure: 99, earningMoney: 999 }),
        ]);

        const feature = await computeFeature(crud, {
            raceId: 4,
            horseNumber: 1,
            horseId: 1,
            jockeyId: "J",
            trainerId: "T",
            date: "2024-04-01",
            distance: 1200,
        });

        expect(feature).toMatchObject({ horseId: 1, raceId: 4, jockeyId: "J", trainerId: "T" });
        // 桁を落とさず出力されることを確かめるため シリアライズ後の文字列で比較する
        expect(JSON.stringify(feature.calculationResultJson)).toBe(
            [
                "{",
                '"sppeed_figure_last":60,',
                '"speed_figure_avg":70,',
                '"winner_avg":1,',
                '"disavesr":[70,1],',
                '"distance_avg":[13333333333333333333,10000000000000000],',
                '"earnings_per_share":50',
                "}",
            ].join(""),
        );
    });

    test("leaves same distance average empty when the race has no distance", async () => {
        await seedRace(1, "2024-01-01", 1200);
        await seedRace(4, "2024-04-01", 1200);
        await crud.insertRaceResults([resultRecord(1, 1, { speedFigure: 80 })]);
        const feature = await computeFeature(crud, {
            raceId: 4,
            horseNumber: 1,
            horseId: 1,
            jockeyId: "J",
            trainerId: "T",
            date: "2024-04-01",
            distance: null,
        });
        expect(feature.calculationResultJson).toMatchObject({ disavesr: null, sppeed_figure_last: 80 });
    });

    test("returns nulls for a horse without history", async () => {
        await seedRace(4, "2024-04-01", 1200);
        const feature = await computeFeature(crud, {
            raceId: 4,
            horseNumber: 1,
            horseId: 1,
            jockeyId: "J",
            trainerId: "T",
            date: "2024-04-01",
            distance: 1200,
        });
        expect(feature.calculationResultJson).toEqual({
            sppeed_figure_last: null,
            speed_figure_avg: null,
            winner_avg: null,
            disavesr: null,
            distance_avg: null,
            earnings_per_share: null,
        });
    });
});

describe("buildFeatures", () => {
    test("warns and does nothing when there are no race results", async () => {
        await buildFeatures(crud, { concurrency: 2, isProgressVisible: false, logger });
        expect(logger.warnings).toEqual(["Failed to retrieve race results."]);
    });

    // 回帰テスト: pending.push(await ...) だと flush による配列の差し替えと競合して結果が失われた
    test("stores a feature for every starter even when batches are flushed concurrently", async () => {
        const raceCount = 30;
        const startersPerRace = 6;
        await crud.insertHorses(
            Array.from({ length: startersPerRace }, (_, i) => ({ id: 100 + i, horseName: `h${i}` })),
        );
        for (let race = 1; race <= raceCount; race++) {
            const date = `2024-01-${String(race).padStart(2, "0")}`;
            await seedRace(race, date, 1200);
            await crud.insertRaceResults(
                Array.from({ length: startersPerRace }, (_, i) =>
                    resultRecord(race, i + 1, { horseId: 100 + i, speedFigure: 50 + i }),
                ),
            );
        }

        await buildFeatures(crud, { concurrency: 8, batchSize: 7, isProgressVisible: false, logger });

        const counts = await db.execute(
            sql`select count(*)::int as total, count(*) filter (where jsonb_typeof(calculation_result_json) = 'object')::int as objects from feature_tbl`,
        );
        expect(counts.rows).toEqual([{ total: raceCount * startersPerRace, objects: raceCount * startersPerRace }]);
    });

    test("is idempotent and updates existing rows", async () => {
        await seedRace(1, "2024-01-01", 1200);
        await crud.insertRaceResults([resultRecord(1, 1)]);
        await buildFeatures(crud, { concurrency: 1, isProgressVisible: false, logger });
        await buildFeatures(crud, { concurrency: 1, isProgressVisible: false, logger });
        const rows = await db.execute(sql`select count(*)::int as n from feature_tbl`);
        expect(rows.rows).toEqual([{ n: 1 }]);
    });
});
