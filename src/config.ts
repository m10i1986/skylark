//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { config as loadDotenv } from "dotenv";

// .env を読み込む 既に設定済みの環境変数は上書きしない
loadDotenv({ quiet: true });

/** 環境変数の値が不正であることを表す */
export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * 環境変数を整数として読み取る
 *
 * @param env - 環境変数
 * @param name - 変数名
 * @param fallback - 未設定時の値
 * @returns 整数
 * @throws {ConfigError} 整数として解釈できない場合
 */
export function readIntegerEnv(env: Environment, name: string, fallback: number): number {
    const raw = env[name];
    if (raw == null || raw === "") {
        return fallback;
    }
    if (!/^[+-]?\d+$/.test(raw.trim())) {
        throw new ConfigError(`${name} must be an integer: ${JSON.stringify(raw)}`);
    }
    return Number(raw.trim());
}

/**
 * 環境変数を実数として読み取る
 *
 * @param env - 環境変数
 * @param name - 変数名
 * @param fallback - 未設定時の値
 * @returns 実数
 * @throws {ConfigError} 実数として解釈できない場合
 */
export function readNumberEnv(env: Environment, name: string, fallback: number): number {
    const raw = env[name];
    if (raw == null || raw === "") {
        return fallback;
    }
    const value = Number(raw.trim());
    if (raw.trim() === "" || !Number.isFinite(value)) {
        throw new ConfigError(`${name} must be a number: ${JSON.stringify(raw)}`);
    }
    return value;
}

/** PostgreSQL への接続設定 */
export type DatabaseConfig = {
    // DATABASE_URL 形式の接続文字列 指定時は個別項目より優先する
    url: string | null;
    hostname: string;
    port: number;
    username: string;
    password: string;
    database: string;
    poolSize: number;
    // 接続を使い回す最大秒数
    maxLifetimeSeconds: number;
    // 空き接続を閉じるまでの秒数
    idleTimeoutSeconds: number;
    connectionTimeoutSeconds: number;
};

/**
 * 環境変数からPostgreSQLの接続設定を作る
 *
 * パスワードの既定値は持たない 必要な場合は環境変数かDATABASE_URLで指定する
 *
 * @param env - 環境変数
 * @returns 接続設定
 * @throws {ConfigError} 数値項目が不正な場合
 */
export function loadDatabaseConfig(env: Environment = process.env): DatabaseConfig {
    const url = env.DATABASE_URL;
    return {
        url: url == null || url === "" ? null : url,
        hostname: env.POSTGRES_HOSTNAME ?? "localhost",
        port: readIntegerEnv(env, "POSTGRES_PORT", 5432),
        username: env.POSTGRES_USERNAME ?? "skylark",
        password: env.POSTGRES_PASSWORD ?? "",
        database: env.POSTGRES_DATABASE ?? "skylark",
        poolSize: readIntegerEnv(env, "DB_POOL_SIZE", 16),
        maxLifetimeSeconds: readIntegerEnv(env, "DB_POOL_RECYCLE", 3600),
        idleTimeoutSeconds: readIntegerEnv(env, "DB_IDLE_TIMEOUT", 30),
        connectionTimeoutSeconds: readIntegerEnv(env, "DB_POOL_TIMEOUT", 30),
    };
}
