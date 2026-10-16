//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import path from "node:path";

import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";

import type { DatabaseConfig } from "../config.ts";
import * as schema from "./schema.ts";

/** Bun組み込みのPostgreSQLクライアントを使うDrizzleのデータベース */
export type SkylarkDatabase = ReturnType<typeof createDatabase>;

// マイグレーションSQLの置き場 リポジトリ直下の drizzle/
const MIGRATIONS_FOLDER = path.join(import.meta.dirname, "..", "..", "drizzle");

/**
 * 接続プールを持つデータベースを作る
 *
 * 接続は最初のクエリ発行時に確立される
 *
 * @param config - 接続設定
 * @returns Drizzleのデータベース 終了時は $client.close() で接続を閉じる
 */
export function createDatabase(config: DatabaseConfig) {
    const poolOptions = {
        max: config.poolSize,
        maxLifetime: config.maxLifetimeSeconds,
        idleTimeout: config.idleTimeoutSeconds,
        connectionTimeout: config.connectionTimeoutSeconds,
    };

    // URL文字列を組み立てると記号を含むパスワードのエスケープが必要になるため 個別項目はそのまま渡す
    const client =
        config.url != null
            ? new SQL({ url: config.url, ...poolOptions })
            : new SQL({
                  adapter: "postgres",
                  hostname: config.hostname,
                  port: config.port,
                  username: config.username,
                  password: config.password,
                  database: config.database,
                  ...poolOptions,
              });

    return drizzle({ client, schema });
}

/**
 * 未適用のマイグレーションをすべて適用する
 *
 * @param db - データベース
 */
export async function runMigrations(db: SkylarkDatabase): Promise<void> {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/**
 * マイグレーションSQLの置き場を返す
 *
 * @returns drizzle/ ディレクトリの絶対パス
 */
export function getMigrationsFolder(): string {
    return MIGRATIONS_FOLDER;
}
