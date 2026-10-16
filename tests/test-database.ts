//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { getMigrationsFolder } from "../src/db/client.ts";
import type { RaceResultRecord } from "../src/db/schema.ts";
import * as schema from "../src/db/schema.ts";

/**
 * テスト用のインメモリPostgreSQL(PGlite)を作り マイグレーションを適用する
 *
 * @returns Drizzleのデータベースと後始末用の関数
 */
export async function createTestDatabase() {
    const client = new PGlite();
    const db = drizzle({ client, schema });
    await migrate(db, { migrationsFolder: getMigrationsFolder() });
    return { db, close: () => client.close() };
}

/** テスト用データベース */
export type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>["db"];

/**
 * レース結果のレコードを作る 引数で上書きしない項目は標準の値になる
 *
 * @param raceId - レースID
 * @param horseNumber - 馬番
 * @param overrides - 上書きする項目
 * @returns レース結果のレコード
 */
export function resultRecord(
    raceId: number,
    horseNumber: number,
    overrides: Partial<RaceResultRecord> = {},
): RaceResultRecord {
    return {
        raceId,
        horseNumber,
        orderOfFinish: 1,
        bracketNumber: 1,
        horseId: 1,
        sex: "牡",
        age: 3,
        basisWeight: 55,
        jockeyId: "00001",
        finishingTime: "00:01:10.5",
        margin: "",
        speedFigure: null,
        passingRank: "1-1",
        lastPhase: 34.5,
        odds: 2.5,
        popularity: 1,
        horseWeight: 480,
        horseWeightDiff: 2,
        remark: null,
        stable: "東",
        trainerId: "00002",
        ownerId: "00003",
        earningMoney: 0,
        ...overrides,
    };
}
