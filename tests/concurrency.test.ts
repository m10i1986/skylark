//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { runWithConcurrency, sleep } from "../src/concurrency.ts";

describe("runWithConcurrency", () => {
    test("processes every item exactly once", async () => {
        const seen: number[] = [];
        await runWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
            await sleep(1);
            seen.push(item);
        });
        expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    });

    test("never exceeds the concurrency limit", async () => {
        let running = 0;
        let peak = 0;
        await runWithConcurrency(
            Array.from({ length: 20 }, (_, i) => i),
            3,
            async () => {
                running++;
                peak = Math.max(peak, running);
                await sleep(2);
                running--;
            },
        );
        expect(peak).toBe(3);
    });

    test("passes the item index", async () => {
        const indexes: number[] = [];
        await runWithConcurrency(["a", "b", "c"], 1, async (_item, index) => {
            indexes.push(index);
        });
        expect(indexes).toEqual([0, 1, 2]);
    });

    test("stops taking new items after a failure and rethrows", async () => {
        const started: number[] = [];
        const run = runWithConcurrency(
            Array.from({ length: 100 }, (_, i) => i),
            2,
            async (item) => {
                started.push(item);
                await sleep(1);
                if (item === 3) {
                    throw new Error("boom");
                }
            },
        );
        await expect(run).rejects.toThrow("boom");
        expect(started.length).toBeLessThan(100);
    });

    test("handles an empty list and rejects an invalid limit", async () => {
        await runWithConcurrency([], 4, async () => {});
        await expect(runWithConcurrency([1], 0, async () => {})).rejects.toThrow(RangeError);
        await expect(runWithConcurrency([1], 1.5, async () => {})).rejects.toThrow(RangeError);
    });
});
