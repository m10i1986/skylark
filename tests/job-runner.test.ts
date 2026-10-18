//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { createJobRunner, formatLocalDateTime, type JobContext, type JobSpec } from "../src/webui/job-runner.ts";
import { createRecordingLogger } from "./mock-fetch.ts";

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };

function deferred(): Deferred {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function spec(execute: (context: JobContext) => Promise<void>, overrides: Partial<JobSpec> = {}): JobSpec {
    return { title: "テスト", commandLine: "--report", isDebug: false, execute, ...overrides };
}

function setup(options: Partial<Parameters<typeof createJobRunner>[0]> = {}) {
    const logger = createRecordingLogger();
    const runner = createJobRunner({ logger, ...options });
    return { runner, logger };
}

function startedId(result: ReturnType<ReturnType<typeof createJobRunner>["start"]>): string {
    if (!result.ok) {
        throw new Error(`job was refused: ${result.reason}`);
    }
    return result.id;
}

describe("job lifecycle", () => {
    test("runs a job and keeps its logs and report in order", async () => {
        const { runner } = setup();
        const id = startedId(
            runner.start(
                spec(async ({ logger, output }) => {
                    logger.info("first");
                    output("report 1\n");
                    logger.warning("second");
                    output("report 2\n");
                }),
            ),
        );
        await runner.whenIdle();

        const job = runner.view(id);
        expect(job?.status).toBe("succeeded");
        expect(job?.finishedAt).not.toBeNull();
        expect(job?.entries.map((entry) => entry.kind)).toEqual(["log", "output", "log", "output"]);
        expect(job?.entries.map((entry) => entry.seq)).toEqual([0, 1, 2, 3]);
        expect(job?.entries[0]?.text).toMatch(/^\[\d{4}-\d{2}-\d{2} [\d:,]+\]\[INFO\] first$/);
        expect(job?.entries[2]?.text).toContain("[WARNING] second");
        expect(job?.entries[1]?.text).toBe("report 1\n");
        expect(job?.title).toBe("テスト");
        expect(job?.commandLine).toBe("--report");
    });

    test("is running until the work finishes", async () => {
        const { runner } = setup();
        const gate = deferred();
        const id = startedId(runner.start(spec(() => gate.promise)));
        expect(runner.view(id)?.status).toBe("running");
        expect(runner.view(id)?.finishedAt).toBeNull();
        expect(runner.runningJobId()).toBe(id);

        gate.resolve();
        await runner.whenIdle();
        expect(runner.view(id)?.status).toBe("succeeded");
        expect(runner.runningJobId()).toBeNull();
    });

    test("records a failure in the log and ends as failed", async () => {
        const { runner, logger } = setup();
        const id = startedId(
            runner.start(
                spec(async () => {
                    throw new Error("database is down");
                }),
            ),
        );
        await runner.whenIdle();

        const job = runner.view(id);
        expect(job?.status).toBe("failed");
        const text = job?.entries.map((entry) => entry.text).join("\n") ?? "";
        expect(text).toContain("[ERROR] database is down");
        expect(logger.ofLevel("error")[0]).toContain("database is down");
        expect(runner.runningJobId()).toBeNull();
    });

    test("fails instead of staying running when the work throws before its first await", async () => {
        const { runner } = setup();
        const id = startedId(
            runner.start(
                spec(() => {
                    throw new Error("synchronous failure");
                }),
            ),
        );
        await runner.whenIdle();

        expect(runner.view(id)?.status).toBe("failed");
        expect(runner.runningJobId()).toBeNull();
        // 次のジョブを始められる
        expect(runner.start(spec(async () => {})).ok).toBe(true);
    });

    test("describes a thrown value that is not an Error", async () => {
        const { runner } = setup();
        const id = startedId(runner.start(spec(() => Promise.reject("plain text"))));
        await runner.whenIdle();
        expect(runner.view(id)?.status).toBe("failed");
        expect(runner.view(id)?.entries.at(-1)?.text).toContain("plain text");
    });

    test("copies the log to the server log", async () => {
        const { runner, logger } = setup();
        runner.start(
            spec(async ({ logger: jobLogger }) => {
                jobLogger.info("visible on the server");
                jobLogger.error("bad", new Error("cause"));
            }),
        );
        await runner.whenIdle();
        expect(logger.ofLevel("info")).toContain("visible on the server");
        expect(logger.ofLevel("error")[0]).toBe("bad");
    });

    test("keeps debug lines only for a debug job", async () => {
        const { runner } = setup();
        const work = async ({ logger }: JobContext): Promise<void> => {
            logger.debug("detail");
        };
        const normal = startedId(runner.start(spec(work)));
        await runner.whenIdle();
        const debug = startedId(runner.start(spec(work, { isDebug: true })));
        await runner.whenIdle();
        expect(runner.view(normal)?.entries).toHaveLength(0);
        expect(runner.view(debug)?.entries[0]?.text).toContain("[DEBUG] detail");
    });
});

describe("one job at a time", () => {
    test("refuses a second job while one is running", async () => {
        const { runner } = setup();
        const gate = deferred();
        const first = startedId(runner.start(spec(() => gate.promise)));
        let started = false;
        const second = runner.start(
            spec(async () => {
                started = true;
            }),
        );
        expect(second).toEqual({ ok: false, reason: "busy", runningJobId: first });

        gate.resolve();
        await runner.whenIdle();
        expect(started).toBe(false);
        expect(runner.start(spec(async () => {})).ok).toBe(true);
    });

    test("refuses new jobs after stopAccepting but lets the running one finish", async () => {
        const { runner } = setup();
        const gate = deferred();
        const id = startedId(runner.start(spec(() => gate.promise)));
        runner.stopAccepting();
        expect(runner.start(spec(async () => {}))).toEqual({ ok: false, reason: "stopping" });

        let isIdle = false;
        const idle = runner.whenIdle().then(() => {
            isIdle = true;
        });
        await Promise.resolve();
        expect(isIdle).toBe(false);

        gate.resolve();
        await idle;
        expect(runner.view(id)?.status).toBe("succeeded");
    });

    test("whenIdle returns at once when nothing is running", async () => {
        const { runner } = setup();
        await runner.whenIdle();
    });
});

describe("views", () => {
    test("returns only the entries after the given number", async () => {
        const { runner } = setup();
        const id = startedId(
            runner.start(
                spec(async ({ output }) => {
                    output("a");
                    output("b");
                    output("c");
                }),
            ),
        );
        await runner.whenIdle();

        expect(runner.view(id)?.entries.map((entry) => entry.text)).toEqual(["a", "b", "c"]);
        expect(runner.view(id, 0)?.entries.map((entry) => entry.text)).toEqual(["b", "c"]);
        expect(runner.view(id, 2)?.entries).toEqual([]);
        // 新しい出力が無いときは 渡された番号をそのまま返す(次の取得でも同じ位置から続く)
        expect(runner.view(id, 2)?.lastSeq).toBe(2);
        expect(runner.view(id, 99)?.lastSeq).toBe(99);
        expect(runner.view(id)?.lastSeq).toBe(2);
    });

    test("returns undefined for an unknown job", () => {
        const { runner } = setup();
        expect(runner.view("nope")).toBeUndefined();
    });

    test("lists the newest job first", async () => {
        const { runner } = setup();
        const first = startedId(runner.start(spec(async () => {}, { title: "first" })));
        await runner.whenIdle();
        const second = startedId(runner.start(spec(async () => {}, { title: "second" })));
        await runner.whenIdle();
        expect(runner.list().map((job) => job.id)).toEqual([second, first]);
        expect(runner.list()[0]).toMatchObject({ title: "second", status: "succeeded" });
        // 一覧にはログを含めない
        expect(runner.list()[0]).not.toHaveProperty("entries");
    });

    test("formats times in local time", () => {
        expect(formatLocalDateTime(new Date(2026, 0, 5, 3, 4, 9))).toBe("2026-01-05 03:04:09");
    });
});

describe("limits", () => {
    test("drops the oldest log lines but never the report", async () => {
        const { runner } = setup({ maxLogLines: 3 });
        const id = startedId(
            runner.start(
                spec(async ({ logger, output }) => {
                    output("REPORT");
                    for (let i = 1; i <= 6; i++) {
                        logger.info(`line ${i}`);
                    }
                }),
            ),
        );
        await runner.whenIdle();

        const job = runner.view(id);
        const logs = job?.entries.filter((entry) => entry.kind === "log").map((entry) => entry.text) ?? [];
        expect(logs).toHaveLength(3);
        expect(logs[0]).toContain("line 4");
        expect(logs[2]).toContain("line 6");
        expect(job?.droppedLogLines).toBe(3);
        expect(job?.entries.find((entry) => entry.kind === "output")?.text).toBe("REPORT");
    });

    test("truncates an overlong log line", async () => {
        const { runner } = setup({ maxLineChars: 20 });
        const id = startedId(
            runner.start(
                spec(async ({ logger }) => {
                    logger.info("x".repeat(500));
                }),
            ),
        );
        await runner.whenIdle();
        const text = runner.view(id)?.entries[0]?.text ?? "";
        expect(text.length).toBeLessThan(60);
        expect(text).toContain("以下省略");
    });

    test("cuts the report at the limit and says so", async () => {
        const { runner } = setup({ maxOutputChars: 10 });
        const id = startedId(
            runner.start(
                spec(async ({ output }) => {
                    output("12345678");
                    output("abcdef");
                    output("ignored");
                }),
            ),
        );
        await runner.whenIdle();
        const job = runner.view(id);
        expect(job?.entries.map((entry) => entry.text)).toEqual(["12345678", "ab"]);
        expect(job?.isOutputTruncated).toBe(true);
    });

    test("does not flag a report that fits", async () => {
        const { runner } = setup({ maxOutputChars: 10 });
        const id = startedId(
            runner.start(
                spec(async ({ output }) => {
                    output("1234567890");
                }),
            ),
        );
        await runner.whenIdle();
        expect(runner.view(id)?.isOutputTruncated).toBe(false);
    });

    test("keeps a bounded number of jobs and drops the oldest finished one", async () => {
        const { runner } = setup({ maxJobs: 2 });
        const ids: string[] = [];
        for (const title of ["a", "b", "c"]) {
            ids.push(startedId(runner.start(spec(async () => {}, { title }))));
            await runner.whenIdle();
        }
        expect(runner.view(ids[0] ?? "")).toBeUndefined();
        expect(runner.list().map((job) => job.title)).toEqual(["c", "b"]);
    });
});
