//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { ConfigError, loadDatabaseConfig, readIntegerEnv, readNumberEnv } from "../src/config.ts";

describe("loadDatabaseConfig", () => {
    test("uses safe defaults and never invents a password", () => {
        const config = loadDatabaseConfig({});
        expect(config).toMatchObject({
            url: null,
            hostname: "localhost",
            port: 5432,
            username: "skylark",
            password: "",
            database: "skylark",
            poolSize: 16,
        });
    });

    test("reads individual variables", () => {
        const config = loadDatabaseConfig({
            POSTGRES_HOSTNAME: "db.example",
            POSTGRES_PORT: "6543",
            POSTGRES_USERNAME: "u",
            POSTGRES_PASSWORD: "p@ss:/word!",
            POSTGRES_DATABASE: "d",
            DB_POOL_SIZE: "4",
        });
        expect(config).toMatchObject({
            hostname: "db.example",
            port: 6543,
            username: "u",
            password: "p@ss:/word!",
            database: "d",
            poolSize: 4,
        });
    });

    test("prefers DATABASE_URL and ignores an empty value", () => {
        expect(loadDatabaseConfig({ DATABASE_URL: "postgres://u:p@h/d" }).url).toBe("postgres://u:p@h/d");
        expect(loadDatabaseConfig({ DATABASE_URL: "" }).url).toBeNull();
    });

    test("rejects a malformed port", () => {
        expect(() => loadDatabaseConfig({ POSTGRES_PORT: "abc" })).toThrow(ConfigError);
    });
});

describe("readIntegerEnv and readNumberEnv", () => {
    test("fall back when unset or empty", () => {
        expect(readIntegerEnv({}, "X", 7)).toBe(7);
        expect(readIntegerEnv({ X: "" }, "X", 7)).toBe(7);
        expect(readNumberEnv({}, "X", 5)).toBe(5);
    });

    test("parse valid values", () => {
        expect(readIntegerEnv({ X: " 12 " }, "X", 7)).toBe(12);
        expect(readNumberEnv({ X: "2.5" }, "X", 5)).toBe(2.5);
        expect(readIntegerEnv({ X: "0" }, "X", 7)).toBe(0);
    });

    test("reject invalid values instead of silently using the default", () => {
        expect(() => readIntegerEnv({ X: "1.5" }, "X", 7)).toThrow(ConfigError);
        expect(() => readNumberEnv({ X: "fast" }, "X", 5)).toThrow(ConfigError);
        expect(() => readNumberEnv({ X: "Infinity" }, "X", 5)).toThrow(ConfigError);
    });
});
