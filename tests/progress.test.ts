//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createProgressReporter } from "../src/progress.ts";

describe("createProgressReporter", () => {
    let written: string[] = [];
    let spy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        written = [];
        spy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
            written.push(String(chunk));
            return true;
        });
    });

    afterEach(() => {
        spy.mockRestore();
    });

    test("writes a line at every 10% and at the end to the given writer", () => {
        // 表示は250ミリ秒ごとに間引かれるため 1件ごとに時刻を進める
        let now = 1_000_000;
        const clock = spyOn(Date, "now").mockImplementation(() => now);
        try {
            const lines: string[] = [];
            const progress = createProgressReporter(10, "feature", { writeLine: (line) => lines.push(line) });
            for (let i = 0; i < 10; i++) {
                now += 300;
                progress.advance();
            }
            progress.finish();

            expect(lines.at(-1)).toBe("feature 100% 10/10");
            expect(lines).toContain("feature  50% 5/10");
            // 同じ割合の行を重ねて出さない
            expect(new Set(lines).size).toBe(lines.length);
            expect(written).toEqual([]);
        } finally {
            clock.mockRestore();
        }
    });

    test("an empty job finishes with 100%", () => {
        const lines: string[] = [];
        createProgressReporter(0, "feature", { writeLine: (line) => lines.push(line) }).finish();
        expect(lines).toEqual(["feature 100% 0/0"]);
    });

    test("writes to stderr as before when no writer is given", () => {
        const progress = createProgressReporter(2, "feature");
        progress.advance();
        progress.advance();
        progress.finish();
        expect(written.at(-1)).toBe("feature 100% 2/2\n");
    });
});
