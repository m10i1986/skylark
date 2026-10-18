//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";

import { parseCliArguments } from "../src/cli-args.ts";
import { SkylarkCrud } from "../src/db/crud.ts";
import { PredictionRepository } from "../src/db/prediction-repository.ts";
import { type DatabaseHandle, type NetkeibaClientLease, runOperations } from "../src/operations.ts";
import type { NetkeibaClient } from "../src/webui/netkeiba-client.ts";
import { createRecordingLogger } from "./mock-fetch.ts";
import { createTestDatabase, resultRecord, type TestDatabase } from "./test-database.ts";

let db: TestDatabase;
let closeDatabase: () => Promise<void>;
let crud: SkylarkCrud;
let tempDirectory: string;

beforeAll(async () => {
    const created = await createTestDatabase();
    db = created.db;
    closeDatabase = created.close;
    crud = new SkylarkCrud(db, createRecordingLogger());
});

afterAll(async () => {
    await closeDatabase();
});

beforeEach(async () => {
    await crud.truncateAllTables();
    // モデルと予測は truncateAllTables の対象外 テスト同士で持ち越さないよう ここで空にする
    await db.execute(sql`TRUNCATE TABLE prediction_tbl, prediction_model_tbl RESTART IDENTITY CASCADE`);
    tempDirectory = await mkdtemp(path.join(tmpdir(), "skylark-operations-"));
});

afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
});

type Harness = {
    logger: ReturnType<typeof createRecordingLogger>;
    outputs: string[];
    progressLines: string[];
    handle: { migrated: number; closed: number };
    leases: { acquired: number; released: number };
    run: (argv: string[], overrides?: { migrate?: () => Promise<void> }) => Promise<void>;
};

function createHarness(): Harness {
    const logger = createRecordingLogger();
    const outputs: string[] = [];
    const progressLines: string[] = [];
    const handle = { migrated: 0, closed: 0 };
    const leases = { acquired: 0, released: 0 };

    // 実際のブラウザは起動しない 使われたら例外になる取得処理
    const client: NetkeibaClient = {
        fetchRaceDates: async () => {
            throw new Error("the site must not be reached");
        },
        fetchRaceList: async () => {
            throw new Error("the site must not be reached");
        },
        fetchRaceInformation: async () => {
            throw new Error("the site must not be reached");
        },
        close: async () => {},
    };

    return {
        logger,
        outputs,
        progressLines,
        handle,
        leases,
        run: (argv, overrides = {}) =>
            runOperations(parseCliArguments(["--temp", tempDirectory, ...argv]), {
                logger,
                output: (text) => outputs.push(text),
                env: {},
                openDatabase: (): DatabaseHandle => ({
                    db,
                    migrate: async () => {
                        handle.migrated++;
                        await overrides.migrate?.();
                    },
                    close: async () => {
                        handle.closed++;
                    },
                }),
                acquireNetkeibaClient: async (): Promise<NetkeibaClientLease> => {
                    leases.acquired++;
                    return {
                        client,
                        release: async () => {
                            leases.released++;
                        },
                    };
                },
                writeProgressLine: (line) => progressLines.push(line),
            }),
    };
}

async function seedRace(raceId: number): Promise<void> {
    await crud.insertHorses([{ id: 1, horseName: "H1" }]);
    await crud.insertRaceInfo({
        id: raceId,
        raceName: `race ${raceId}`,
        date: "2025-07-06",
        distance: 1200,
        raceNumber: 1,
        placeDetail: "札幌",
    });
}

describe("runOperations", () => {
    test("creates the cache directory, migrates and closes the database", async () => {
        const nested = path.join(tempDirectory, "cache", "deeper");
        const harness = createHarness();
        await runOperations(parseCliArguments(["--temp", nested, "--report", "--date", "2026-01-31"]), {
            logger: harness.logger,
            output: (text) => harness.outputs.push(text),
            env: {},
            openDatabase: () => ({
                db,
                migrate: async () => {
                    harness.handle.migrated++;
                },
                close: async () => {
                    harness.handle.closed++;
                },
            }),
        });
        expect((await stat(nested)).isDirectory()).toBe(true);
        expect(harness.handle).toEqual({ migrated: 1, closed: 1 });
    });

    test("reports saved predictions of the given date to the output", async () => {
        const harness = createHarness();
        await harness.run(["--report", "--date", "2026-01-31"]);
        expect(harness.outputs).toEqual(["2026-01-31 の保存済みの予測はありません (-P で予測してください)\n"]);
    });

    test("--rebuild-all-tables empties the tables", async () => {
        await seedRace(202501010101);
        expect(await crud.getRaceInfo(202501010101)).toBeDefined();

        const harness = createHarness();
        await harness.run(["--rebuild-all-tables"]);
        expect(await crud.getRaceInfo(202501010101)).toBeUndefined();
    });

    test("--rebuild-all-tables keeps the saved models and predictions (they cannot be fetched again)", async () => {
        // 取得し直せない記録 画面と README で「削除しない」と案内している
        await seedRace(202605040701);
        const repository = new PredictionRepository(db);
        const modelId = await repository.insertModel({
            circuit: "jra",
            trainFrom: "2025-04-05",
            validFrom: "2026-03-27",
            testFrom: "2026-07-05",
            dataTo: "2026-10-12",
            parameters: { version: 1 },
            metrics: {},
        });
        await repository.insertPredictions([
            {
                modelId,
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
            },
        ]);

        const harness = createHarness();
        await harness.run(["--rebuild-all-tables"]);

        expect(await crud.getRaceInfo(202605040701)).toBeUndefined();
        expect((await repository.getLatestModel("jra"))?.id).toBe(modelId);
        expect(await repository.listPredictionsWithResults("2026-10-18")).toHaveLength(1);
    });

    test("does nothing to the data when no destructive option is given", async () => {
        await seedRace(202501010101);
        const harness = createHarness();
        await harness.run(["--report", "--date", "2026-01-31"]);
        expect(await crud.getRaceInfo(202501010101)).toBeDefined();
    });

    test("--feature without results only warns", async () => {
        const harness = createHarness();
        await harness.run(["--feature"]);
        expect(harness.logger.ofLevel("warning")).toEqual(["Failed to retrieve race results."]);
        expect(harness.progressLines).toEqual([]);
    });

    test("--feature sends the progress to the given writer instead of stderr", async () => {
        await seedRace(202501010101);
        await crud.insertRaceResults([resultRecord(202501010101, 1, { horseId: 1 })]);
        const harness = createHarness();
        await harness.run(["--feature"]);
        expect(harness.progressLines.length).toBeGreaterThan(0);
        expect(harness.progressLines.at(-1)).toMatch(/^feature\s+100% 1\/1$/);
    });

    test("closes the database when a step fails", async () => {
        const harness = createHarness();
        await expect(
            harness.run(["--report"], {
                migrate: async () => {
                    throw new Error("migration failed");
                },
            }),
        ).rejects.toThrow("migration failed");
        expect(harness.handle.closed).toBe(1);
    });
});

describe("runOperations: prediction", () => {
    test("rejects a malformed race id before borrowing the browser", async () => {
        const harness = createHarness();
        await expect(harness.run(["--predict", "--", "12ab"])).rejects.toThrow('invalid race id: "12ab"');
        expect(harness.leases.acquired).toBe(0);
        expect(harness.handle.closed).toBe(1);
    });

    test("releases the browser even when the prediction fails", async () => {
        const harness = createHarness();
        await expect(harness.run(["--predict"])).rejects.toThrow("no trained model");
        expect(harness.leases).toEqual({ acquired: 1, released: 1 });
        expect(harness.handle.closed).toBe(1);
    });

    test("does not borrow the browser unless --predict is given", async () => {
        const harness = createHarness();
        await harness.run(["--report", "--date", "2026-01-31"]);
        expect(harness.leases.acquired).toBe(0);
    });
});

describe("runOperations: training", () => {
    test("fails without losing the database connection handling when there is no data", async () => {
        const harness = createHarness();
        await expect(harness.run(["--train"])).rejects.toThrow();
        expect(harness.logger.ofLevel("info")).toContain("Start train");
        expect(harness.handle.closed).toBe(1);
    });
});
