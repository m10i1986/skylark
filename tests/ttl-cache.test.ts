//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { createTtlCache } from "../src/webui/ttl-cache.ts";

describe("createTtlCache", () => {
    test("returns a value until it expires", () => {
        let now = 1000;
        const cache = createTtlCache<string, number>(100, 10, () => now);
        cache.set("a", 1);
        expect(cache.get("a")).toBe(1);
        now = 1099;
        expect(cache.get("a")).toBe(1);
        now = 1100;
        expect(cache.get("a")).toBeUndefined();
    });

    test("evicts the oldest entries beyond the limit", () => {
        const cache = createTtlCache<string, number>(1000, 2);
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("c", 3);
        expect(cache.get("a")).toBeUndefined();
        expect(cache.get("b")).toBe(2);
        expect(cache.get("c")).toBe(3);
    });

    test("overwriting a key refreshes its position and expiry", () => {
        let now = 0;
        const cache = createTtlCache<string, number>(100, 2, () => now);
        cache.set("a", 1);
        cache.set("b", 2);
        now = 50;
        cache.set("a", 10);
        cache.set("c", 3);
        expect(cache.get("b")).toBeUndefined();
        expect(cache.get("a")).toBe(10);
        now = 149;
        expect(cache.get("a")).toBe(10);
    });

    test("getOrLoad loads once and then serves from the cache", async () => {
        const cache = createTtlCache<string, number>(1000, 10);
        let calls = 0;
        const load = async () => {
            calls++;
            return 42;
        };
        expect(await cache.getOrLoad("k", load)).toBe(42);
        expect(await cache.getOrLoad("k", load)).toBe(42);
        expect(calls).toBe(1);
    });

    test("getOrLoad shares one in-flight load between concurrent callers", async () => {
        const cache = createTtlCache<string, number>(1000, 10);
        let calls = 0;
        const load = async () => {
            calls++;
            await Bun.sleep(5);
            return 7;
        };
        const results = await Promise.all([cache.getOrLoad("k", load), cache.getOrLoad("k", load)]);
        expect(results).toEqual([7, 7]);
        expect(calls).toBe(1);
    });

    test("does not cache a failed load and retries next time", async () => {
        const cache = createTtlCache<string, number>(1000, 10);
        let calls = 0;
        const load = async () => {
            calls++;
            if (calls === 1) {
                throw new Error("temporary");
            }
            return 5;
        };
        await expect(cache.getOrLoad("k", load)).rejects.toThrow("temporary");
        expect(await cache.getOrLoad("k", load)).toBe(5);
    });

    test("caches falsy values such as an empty list", async () => {
        const cache = createTtlCache<string, string[]>(1000, 10);
        let calls = 0;
        const load = async () => {
            calls++;
            return [];
        };
        await cache.getOrLoad("k", load);
        await cache.getOrLoad("k", load);
        expect(calls).toBe(1);
    });
});
