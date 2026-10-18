//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createLogger, createLoggerWithSink, describeError } from "../src/logger.ts";

describe("describeError", () => {
    test("includes the cause chain that ORMs hide", () => {
        const root = Object.assign(new Error("deadlock detected"), { code: "40P01" });
        const wrapped = new Error("Failed query: insert ...", { cause: root });
        const text = describeError(wrapped);
        expect(text).toContain("Failed query: insert");
        expect(text).toContain("Caused by:");
        expect(text).toContain("deadlock detected");
        expect(text).toContain("[code=40P01]");
    });

    test("stringifies non Error values", () => {
        expect(describeError("plain")).toBe("plain");
        expect(describeError(42)).toBe("42");
    });

    test("stops following a cyclic cause chain", () => {
        const a = new Error("a");
        const b = new Error("b", { cause: a });
        a.cause = b;
        expect(describeError(a).split("Caused by:").length).toBeLessThanOrEqual(5);
    });
});

describe("createLogger", () => {
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

    test("filters by level and formats timestamp and level", () => {
        const logger = createLogger("info");
        logger.debug("hidden");
        logger.info("shown");
        logger.warning("careful");
        logger.error("bad", new Error("why"));
        expect(written).toHaveLength(3);
        expect(written[0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}\]\[INFO\] shown\n$/);
        expect(written[1]).toContain("[WARNING] careful");
        expect(written[2]).toContain("[ERROR] bad");
        expect(written[2]).toContain("why");
    });

    test("debug level shows everything", () => {
        createLogger("debug").debug("visible");
        expect(written[0]).toContain("[DEBUG] visible");
    });
});

describe("createLoggerWithSink", () => {
    test("hands each entry to the sink without a trailing newline and without touching stderr", () => {
        const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const lines: string[] = [];
            const logger = createLoggerWithSink("info", (line) => lines.push(line));
            logger.debug("hidden");
            logger.info("shown");
            logger.error("bad", new Error("why"));
            expect(lines).toHaveLength(2);
            expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}\]\[INFO\] shown$/);
            expect(lines[1]).toContain("[ERROR] bad");
            expect(lines[1]).toContain("why");
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
});
