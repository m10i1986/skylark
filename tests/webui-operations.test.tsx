//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { beforeEach, describe, expect, test } from "bun:test";

import { type CliArguments, USAGE } from "../src/cli-args.ts";
import { createJobRunner, type JobContext, type JobView } from "../src/webui/job-runner.ts";
import type { NetkeibaClient } from "../src/webui/netkeiba-client.ts";
import { FLAG_FIELDS, FLAG_ON, TEXT_FIELDS } from "../src/webui/operation-fields.ts";
import { type JobEventsResponse, mergeJobEvents } from "../src/webui/operations-views.tsx";
import { createApp, startWebUi } from "../src/webui/server.tsx";
import { createRecordingLogger } from "./mock-fetch.ts";

const TEMP_DIRECTORY = "./test-temp";

type Harness = {
    app: ReturnType<typeof createApp>;
    runner: ReturnType<typeof createJobRunner>;
    executed: CliArguments[];
    logger: ReturnType<typeof createRecordingLogger>;
    behavior: { work: (context: JobContext) => Promise<void> };
};

function createHarness(options: { hasOperations?: boolean } = {}): Harness {
    const logger = createRecordingLogger();
    const runner = createJobRunner({ logger });
    const executed: CliArguments[] = [];
    const behavior: Harness["behavior"] = {
        work: async ({ logger: jobLogger, output }) => {
            jobLogger.info("working");
            output("REPORT\n");
        },
    };
    const client: NetkeibaClient = {
        fetchRaceDates: async () => [],
        fetchRaceList: async () => [],
        fetchRaceInformation: async () => {
            throw new Error("not used");
        },
        close: async () => {},
    };
    const app = createApp({
        client,
        logger,
        today: () => "2025-07-01",
        isHostAllowed: (hostname) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname),
        isRaceSaved: async () => false,
        saveRaceInfo: async () => {},
        operations:
            options.hasOperations === false
                ? undefined
                : {
                      runner,
                      tempDirectory: TEMP_DIRECTORY,
                      createExecutor: (args) => async (context) => {
                          executed.push(args);
                          await behavior.work(context);
                      },
                  },
    });
    return { app, runner, executed, logger, behavior };
}

const FORM_HEADERS = {
    "content-type": "application/x-www-form-urlencoded",
    origin: "http://localhost",
    host: "localhost",
};
const GET_HEADERS = { host: "localhost" };

function postOperations(harness: Harness, fields: Record<string, string>, headers: Record<string, string> = {}) {
    return harness.app.request("/operations", {
        method: "POST",
        headers: { ...FORM_HEADERS, ...headers },
        body: new URLSearchParams(fields).toString(),
    });
}

function jobIdOf(response: Response): string {
    const match = /^\/jobs\/([0-9a-f-]{36})$/.exec(response.headers.get("location") ?? "");
    if (match?.[1] == null) {
        throw new Error(`no job was started: ${response.status} ${response.headers.get("location")}`);
    }
    return match[1];
}

let harness: Harness;

beforeEach(() => {
    harness = createHarness();
});

describe("when operations are not provided", () => {
    test("has no operation routes and no navigation", async () => {
        const disabled = createHarness({ hasOperations: false });
        for (const path of ["/operations", "/jobs/00000000-0000-7000-8000-000000000000"]) {
            expect((await disabled.app.request(path, { headers: GET_HEADERS })).status).toBe(404);
        }
        const post = await postOperations(disabled, { report: FLAG_ON });
        expect(post.status).toBe(404);
        const index = await (await disabled.app.request("/", { headers: GET_HEADERS })).text();
        expect(index).not.toContain("/operations");
    });

    test("the race page links to the operations page only when they are provided", async () => {
        const enabled = await (await harness.app.request("/", { headers: GET_HEADERS })).text();
        expect(enabled).toContain('href="/operations"');
    });
});

describe("GET /operations", () => {
    test("shows the form with the command line defaults", async () => {
        const response = await harness.app.request("/operations", { headers: GET_HEADERS });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain('method="post"');
        expect(html).toContain('action="/operations"');
        expect(html).toContain('placeholder="2025-01-01"');
        expect(html).toContain('placeholder="race_list.txt"');
        expect(html).toContain(TEMP_DIRECTORY);
    });

    test("has an input for every field the server accepts", async () => {
        const html = await (await harness.app.request("/operations", { headers: GET_HEADERS })).text();
        for (const name of [...FLAG_FIELDS, ...TEXT_FIELDS]) {
            expect(html).toContain(`name="${name}"`);
        }
    });

    test("covers every command line option (--temp and --help are intentionally left out)", async () => {
        const html = await (await harness.app.request("/operations", { headers: GET_HEADERS })).text();
        const leftOut = new Set(["--temp", "--help"]);
        const usageOptions = [...new Set(USAGE.match(/--[a-z][a-z-]*/g) ?? [])].filter((name) => !leftOut.has(name));
        expect(usageOptions.length).toBeGreaterThan(10);
        for (const option of usageOptions) {
            expect(html).toContain(option);
        }
        // 「-U, --update-race-list」のように短い形式を持つオプションは 短い形式も画面に出す
        const shortOptions = [...USAGE.matchAll(/^\s+(-[A-Za-z]+),/gm)]
            .map((match) => match[1] ?? "")
            .filter((name) => name !== "-h");
        expect(shortOptions).toEqual(["-Rf", "-U", "-S", "-F", "-T", "-P", "-B"]);
        for (const short of shortOptions) {
            expect(html).toContain(`(${short}, `);
        }
    });

    test("never lets the HTML cache directory be typed in", async () => {
        const html = await (await harness.app.request("/operations", { headers: GET_HEADERS })).text();
        expect(html).not.toContain('name="temp"');
    });

    test("allows the polling requests of the job page in the content security policy", async () => {
        const response = await harness.app.request("/operations", { headers: GET_HEADERS });
        const csp = response.headers.get("content-security-policy") ?? "";
        expect(csp).toContain("connect-src 'self'");
        expect(csp).toContain("default-src 'none'");
        expect(csp).not.toMatch(/script-src[^;]*'unsafe-/);
    });

    test("hands the page kind and values to the client as JSON", async () => {
        const html = await (await harness.app.request("/operations", { headers: GET_HEADERS })).text();
        const match = /<script id="skylark-props" type="application\/json">(.*?)<\/script>/s.exec(html);
        const props = JSON.parse(match?.[1] ?? "null");
        expect(props.page).toBe("operations");
        expect(props.defaults.tempDirectory).toBe(TEMP_DIRECTORY);
    });

    test("rejects an unexpected Host header", async () => {
        const response = await harness.app.request("/operations", { headers: { host: "evil.example" } });
        expect(response.status).toBe(403);
    });
});

describe("POST /operations", () => {
    test("starts a job and redirects to its page", async () => {
        const response = await postOperations(harness, { updateRaceList: FLAG_ON, scraping: FLAG_ON });
        expect(response.status).toBe(303);
        const id = jobIdOf(response);
        await harness.runner.whenIdle();

        expect(harness.executed).toHaveLength(1);
        expect(harness.executed[0]).toMatchObject({ isUpdateRaceList: true, isScraping: true, isFeature: false });
        expect(harness.runner.view(id)?.status).toBe("succeeded");
        expect(harness.runner.view(id)?.commandLine).toBe("--update-race-list --scraping");
    });

    test("passes the settings of the form to the job", async () => {
        const response = await postOperations(harness, {
            predict: FLAG_ON,
            verbose: FLAG_ON,
            minOdds: "20",
            raceIds: "202605040701 202605040702",
        });
        jobIdOf(response);
        await harness.runner.whenIdle();
        expect(harness.executed[0]).toMatchObject({
            isPredict: true,
            isVerbose: true,
            raceIds: ["202605040701", "202605040702"],
            valueCriteria: { minOdds: 20 },
        });
    });

    test("starts an AI box job with the ticket limit of the form", async () => {
        const response = await postOperations(harness, {
            aiBox: FLAG_ON,
            boxMaxTickets: "24",
            raceIds: "202605040711",
        });
        jobIdOf(response);
        await harness.runner.whenIdle();
        expect(harness.executed[0]).toMatchObject({
            isAiBox: true,
            boxMaxTickets: 24,
            raceIds: ["202605040711"],
        });
    });

    test("refuses an AI box without race ids and starts nothing, because every race calls the paid API", async () => {
        const response = await postOperations(harness, { aiBox: FLAG_ON });
        expect(response.status).toBe(400);
        expect(await response.text()).toContain("3連単Boxの提案(-B)には、レース ID を 1 〜 12 件指定してください。");
        await harness.runner.whenIdle();
        expect(harness.executed).toHaveLength(0);
    });

    test("fixes the HTML cache directory on the server", async () => {
        const response = await postOperations(harness, { scraping: FLAG_ON, temp: "/etc", "--temp": "/etc" });
        jobIdOf(response);
        await harness.runner.whenIdle();
        expect(harness.executed[0]?.temp).toBe(TEMP_DIRECTORY);
    });

    test("shows the errors, keeps the input and starts nothing for an invalid form", async () => {
        const response = await postOperations(harness, { scraping: FLAG_ON, raceListFile: "../../etc/passwd" });
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("レース一覧のファイル名は");
        expect(html).toContain('value="../../etc/passwd"');
        expect(html).toContain('checked=""');
        expect(harness.executed).toHaveLength(0);
        expect(harness.runner.list()).toHaveLength(0);
    });

    test("escapes the input it shows again", async () => {
        const response = await postOperations(harness, {
            report: FLAG_ON,
            date: '"><script>alert(1)</script>',
        });
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).not.toContain("<script>alert(1)</script>");
    });

    test("needs a chosen action", async () => {
        const response = await postOperations(harness, { verbose: FLAG_ON });
        expect(response.status).toBe(400);
        expect(await response.text()).toContain("実行する処理を1つ以上選んでください。");
    });

    test("does not delete tables without the confirmation (checked by the server)", async () => {
        const rejected = await postOperations(harness, { rebuildAllTables: FLAG_ON });
        expect(rejected.status).toBe(400);
        expect(harness.executed).toHaveLength(0);

        const rejectedFeature = await postOperations(harness, { rebuildFeature: FLAG_ON });
        expect(rejectedFeature.status).toBe(400);
        expect(harness.executed).toHaveLength(0);

        const accepted = await postOperations(harness, { rebuildAllTables: FLAG_ON, confirmRebuildAllTables: FLAG_ON });
        jobIdOf(accepted);
        await harness.runner.whenIdle();
        expect(harness.executed[0]?.isRebuildAllTables).toBe(true);
    });

    test("refuses a second job while one is running", async () => {
        let release!: () => void;
        harness.behavior.work = () =>
            new Promise<void>((resolve) => {
                release = resolve;
            });
        const first = await postOperations(harness, { report: FLAG_ON });
        const firstId = jobIdOf(first);

        const second = await postOperations(harness, { report: FLAG_ON });
        expect(second.status).toBe(409);
        const html = await second.text();
        expect(html).toContain("別のジョブが実行中");
        expect(html).toContain(`/jobs/${firstId}`);
        expect(harness.executed).toHaveLength(1);

        release();
        await harness.runner.whenIdle();
        harness.behavior.work = async () => {};
        const third = await postOperations(harness, { report: FLAG_ON });
        expect(third.status).toBe(303);
        await harness.runner.whenIdle();
    });

    test("refuses a job while the server is stopping", async () => {
        harness.runner.stopAccepting();
        const response = await postOperations(harness, { report: FLAG_ON });
        expect(response.status).toBe(503);
        expect(harness.executed).toHaveLength(0);
    });

    test("is rejected for a cross origin request", async () => {
        const response = await postOperations(harness, { report: FLAG_ON }, { origin: "http://evil.example" });
        expect(response.status).toBe(403);
        expect(harness.executed).toHaveLength(0);
    });

    test("is rejected for a request without an origin", async () => {
        const response = await harness.app.request("/operations", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost" },
            body: "report=1",
        });
        expect(response.status).toBe(403);
        expect(harness.executed).toHaveLength(0);
    });

    test("is rejected for an unexpected Host header", async () => {
        const response = await postOperations(harness, { report: FLAG_ON }, { host: "evil.example" });
        expect(response.status).toBe(403);
        expect(harness.executed).toHaveLength(0);
    });

    test("is rejected when the body is too large", async () => {
        const response = await postOperations(harness, { scraping: FLAG_ON, raceIds: "1".repeat(100_000) });
        expect(response.status).toBe(413);
        expect(harness.executed).toHaveLength(0);
    });

    test("lists the finished jobs on the operations page", async () => {
        jobIdOf(await postOperations(harness, { report: FLAG_ON }));
        await harness.runner.whenIdle();
        const html = await (await harness.app.request("/operations", { headers: GET_HEADERS })).text();
        expect(html).toContain("結果の突き合わせ");
        expect(html).toContain("成功");
    });
});

describe("GET /jobs/:id", () => {
    test("shows the report, the log and the equivalent command line", async () => {
        const id = jobIdOf(await postOperations(harness, { report: FLAG_ON, date: "2026-01-31" }));
        await harness.runner.whenIdle();

        const response = await harness.app.request(`/jobs/${id}`, { headers: GET_HEADERS });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("結果の突き合わせ");
        expect(html).toContain("REPORT");
        expect(html).toContain("[INFO] working");
        expect(html).toContain("bun run src/cli.ts --report --date=2026-01-31");
        expect(html).toContain("成功");
    });

    test("escapes the log and keeps '<' out of the embedded JSON", async () => {
        harness.behavior.work = async ({ logger }) => {
            logger.info("<script>alert(1)</script>");
        };
        const id = jobIdOf(await postOperations(harness, { report: FLAG_ON }));
        await harness.runner.whenIdle();

        const html = await (await harness.app.request(`/jobs/${id}`, { headers: GET_HEADERS })).text();
        expect(html).not.toContain("<script>alert(1)</script>");
        expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        const match = /<script id="skylark-props" type="application\/json">(.*?)<\/script>/s.exec(html);
        expect(match?.[1]).not.toContain("<");
        const props = JSON.parse(match?.[1] ?? "null");
        expect(props.page).toBe("job");
        expect(props.job.entries.some((entry: { text: string }) => entry.text.includes("<script>"))).toBe(true);
    });

    test("shows a failed job", async () => {
        harness.behavior.work = async () => {
            throw new Error("boom");
        };
        const id = jobIdOf(await postOperations(harness, { report: FLAG_ON }));
        await harness.runner.whenIdle();
        const html = await (await harness.app.request(`/jobs/${id}`, { headers: GET_HEADERS })).text();
        expect(html).toContain("失敗");
        expect(html).toContain("boom");
    });

    test("answers 404 for unknown or malformed ids", async () => {
        for (const id of [
            "00000000-0000-7000-8000-000000000000",
            "00000000-0000-4000-8000-000000000000",
            "abc",
            "..%2F..%2Fetc",
            "1",
            "constructor",
        ]) {
            const response = await harness.app.request(`/jobs/${id}`, { headers: GET_HEADERS });
            expect(response.status).toBe(404);
        }
    });

    test("rejects an unexpected Host header", async () => {
        const id = jobIdOf(await postOperations(harness, { report: FLAG_ON }));
        await harness.runner.whenIdle();
        const response = await harness.app.request(`/jobs/${id}`, { headers: { host: "evil.example" } });
        expect(response.status).toBe(403);
    });
});

describe("GET /jobs/:id/events", () => {
    async function finishedJob(): Promise<string> {
        harness.behavior.work = async ({ logger, output }) => {
            logger.info("one");
            output("report\n");
            logger.info("two");
        };
        const id = jobIdOf(await postOperations(harness, { report: FLAG_ON }));
        await harness.runner.whenIdle();
        return id;
    }

    // テスト専用 サーバーが返すJSONの形はここだけで断定する
    async function fetchEvents(id: string, query = ""): Promise<JobEventsResponse> {
        const response = await harness.app.request(`/jobs/${id}/events${query}`, { headers: GET_HEADERS });
        return (await response.json()) as JobEventsResponse;
    }

    test("returns the state and the entries after the given number as JSON", async () => {
        const id = await finishedJob();

        const all = await harness.app.request(`/jobs/${id}/events`, { headers: GET_HEADERS });
        expect(all.status).toBe(200);
        expect(all.headers.get("content-type")).toContain("application/json");
        expect(all.headers.get("cache-control")).toBe("no-store");
        const body = await fetchEvents(id);
        expect(body.status).toBe("succeeded");
        expect(body.entries.map((entry) => entry.seq)).toEqual([0, 1, 2]);
        expect(body.lastSeq).toBe(2);
        expect(body.finishedAt).not.toBeNull();

        const rest = await fetchEvents(id, "?after=0");
        expect(rest.entries.map((entry) => entry.seq)).toEqual([1, 2]);

        const none = await fetchEvents(id, "?after=2");
        expect(none.entries).toEqual([]);
        expect(none.lastSeq).toBe(2);
    });

    test("treats an invalid after as the beginning", async () => {
        const id = await finishedJob();
        for (const after of ["abc", "-1", "1e3", "99999999999999", ""]) {
            const body = await fetchEvents(id, `?after=${after}`);
            expect(body.entries.map((entry) => entry.seq)).toEqual([0, 1, 2]);
        }
    });

    test("reports a running job as running", async () => {
        let release!: () => void;
        harness.behavior.work = async ({ logger }) => {
            logger.info("started");
            await new Promise<void>((resolve) => {
                release = resolve;
            });
        };
        const id = jobIdOf(await postOperations(harness, { report: FLAG_ON }));
        const body = await fetchEvents(id);
        expect(body.status).toBe("running");
        expect(body.finishedAt).toBeNull();
        release();
        await harness.runner.whenIdle();
    });

    test("answers 404 for unknown jobs", async () => {
        const response = await harness.app.request("/jobs/00000000-0000-7000-8000-000000000000/events", {
            headers: GET_HEADERS,
        });
        expect(response.status).toBe(404);
    });
});

describe("mergeJobEvents", () => {
    function view(overrides: Partial<JobView> = {}): JobView {
        return {
            id: "id",
            title: "t",
            commandLine: "--report",
            status: "running",
            startedAt: "2026-01-01 00:00:00",
            finishedAt: null,
            entries: [],
            droppedLogLines: 0,
            isOutputTruncated: false,
            lastSeq: -1,
            ...overrides,
        };
    }

    function update(overrides: Partial<JobEventsResponse> = {}): JobEventsResponse {
        return {
            status: "running",
            finishedAt: null,
            entries: [],
            droppedLogLines: 0,
            isOutputTruncated: false,
            lastSeq: -1,
            ...overrides,
        };
    }

    test("appends new entries and takes the latest state", () => {
        const first = mergeJobEvents(view(), update({ entries: [{ seq: 0, kind: "log", text: "a" }], lastSeq: 0 }));
        const second = mergeJobEvents(
            first,
            update({
                status: "succeeded",
                finishedAt: "2026-01-01 00:01:00",
                entries: [{ seq: 1, kind: "output", text: "r" }],
                lastSeq: 1,
            }),
        );
        expect(second.entries.map((entry) => entry.seq)).toEqual([0, 1]);
        expect(second.status).toBe("succeeded");
        expect(second.finishedAt).toBe("2026-01-01 00:01:00");
        expect(second.lastSeq).toBe(1);
    });

    test("ignores entries it already has", () => {
        const first = mergeJobEvents(view(), update({ entries: [{ seq: 0, kind: "log", text: "a" }], lastSeq: 0 }));
        const again = mergeJobEvents(
            first,
            update({
                entries: [
                    { seq: 0, kind: "log", text: "a" },
                    { seq: 1, kind: "log", text: "b" },
                ],
                lastSeq: 1,
            }),
        );
        expect(again.entries.map((entry) => entry.text)).toEqual(["a", "b"]);
    });

    test("keeps the report and drops the oldest log lines beyond the limit", () => {
        const entries = [
            { seq: 0, kind: "output" as const, text: "REPORT" },
            ...Array.from({ length: 2005 }, (_, i) => ({ seq: i + 1, kind: "log" as const, text: `line ${i}` })),
        ];
        const merged = mergeJobEvents(view(), update({ entries, lastSeq: 2005 }));
        const logs = merged.entries.filter((entry) => entry.kind === "log");
        expect(logs).toHaveLength(2000);
        expect(logs[0]?.text).toBe("line 5");
        expect(merged.entries.find((entry) => entry.kind === "output")?.text).toBe("REPORT");
        expect(merged.droppedLogLines).toBe(5);
    });
});

describe("startWebUi: who can use the operations", () => {
    // 127.0.0.2 は自分のPCの中だけに届くが ループバックとして扱う名前(localhostなど)には含まれない
    const NON_LOOPBACK_HOST = "127.0.0.2";

    async function statusOf(port: number, host: string, path: string): Promise<number> {
        const response = await fetch(`http://${host}:${port}${path}`);
        await response.arrayBuffer();
        return response.status;
    }

    test("enables the operations on a loopback host", async () => {
        const logger = createRecordingLogger();
        const server = startWebUi({ hostname: "127.0.0.1", port: 0 }, logger);
        try {
            expect(await statusOf(server.port, "127.0.0.1", "/operations")).toBe(200);
            expect(server.hasRunningJob()).toBe(false);
            expect(logger.ofLevel("warning")).toEqual([]);
        } finally {
            await server.stop();
        }
    });

    test("disables the operations on another host unless they are allowed explicitly", async () => {
        const logger = createRecordingLogger();
        const server = startWebUi({ hostname: NON_LOOPBACK_HOST, port: 0 }, logger);
        try {
            expect(await statusOf(server.port, NON_LOOPBACK_HOST, "/operations")).toBe(404);
            expect(await statusOf(server.port, NON_LOOPBACK_HOST, "/jobs/00000000-0000-7000-8000-000000000000")).toBe(
                404,
            );
            const post = await fetch(`http://${NON_LOOPBACK_HOST}:${server.port}/operations`, {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    origin: `http://${NON_LOOPBACK_HOST}:${server.port}`,
                },
                body: "rebuildAllTables=1&confirmRebuildAllTables=1",
            });
            expect(post.status).toBe(404);
            expect(logger.ofLevel("info").join("\n")).toContain("WEBUI_ENABLE_OPERATIONS");
        } finally {
            await server.stop();
        }
    });

    test("enables the operations on another host when allowed, and warns about it", async () => {
        const logger = createRecordingLogger();
        const server = startWebUi({ hostname: NON_LOOPBACK_HOST, port: 0, isOperationsAllowedOnNetwork: true }, logger);
        try {
            expect(await statusOf(server.port, NON_LOOPBACK_HOST, "/operations")).toBe(200);
            expect(logger.ofLevel("warning").join("\n")).toContain("operations are enabled");
        } finally {
            await server.stop();
        }
    });
});
