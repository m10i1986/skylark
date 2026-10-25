//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CliArguments } from "../src/cli-args.ts";
import type { RaceInfoRecord } from "../src/db/schema.ts";
import { createJobRunner } from "../src/webui/job-runner.ts";
import type {
    HorseEntry,
    NetkeibaClient,
    RaceDate,
    RaceInformation,
    RaceListItem,
} from "../src/webui/netkeiba-client.ts";
import { createApp, type WebUiDependencies } from "../src/webui/server.tsx";
import { selectionPath } from "../src/webui/views.tsx";
import { createRecordingLogger } from "./mock-fetch.ts";

const HORSE: HorseEntry = {
    horseId: 2099100001,
    horseNumber: 3,
    wakuNumber: 2,
    horseName: "テストホース<b>",
    barei: "牝2",
    basisWeight: 55,
    jockeyId: "01001",
    jockeyName: "騎手",
    trainerId: "01002",
    trainerName: "調教師",
    odds: 4.8,
    popularity: 3,
    horseWeight: 408,
    horseWeightDiff: 4,
};

const DATES: RaceDate[] = [
    { text: "7/6(日)", href: "race_list.html?kaisai_date=20250706", kaisaiDate: "2025-07-06" },
    { text: "7/13(日)", href: "race_list.html?kaisai_date=20250713", kaisaiDate: "2025-07-13" },
];

const RACES: RaceListItem[] = [
    {
        courseName: "札幌",
        raceNumber: "1R",
        raceName: "テスト未勝利",
        text: "札幌 - 1R  - テスト未勝利",
        href: "../race/shutuba.html?race_id=209901010101",
        raceId: 209901010101,
    },
    {
        courseName: "札幌",
        raceNumber: "2R",
        raceName: "名称",
        text: "札幌 - 2R  - 名称",
        href: "../race/shutuba.html?race_id=209901010102",
        raceId: 209901010102,
    },
];

function information(raceId: number, overrides: Partial<RaceInformation["race"]> = {}): RaceInformation {
    return {
        race: {
            id: raceId,
            raceName: "テスト未勝利<script>alert(1)</script>",
            distance: 1200,
            weather: "曇",
            postTime: "09:55",
            raceNumber: 1,
            runDirection: "右",
            trackSurface: "芝",
            trackCondition: "良",
            trackConditionScore: null,
            raceGrade: 4,
            raceClass: "未勝利",
            ...overrides,
        },
        horses: [HORSE],
    };
}

type Harness = {
    app: ReturnType<typeof createApp>;
    saved: RaceInfoRecord[];
    savedIds: Set<number>;
    calls: { dates: number; lists: string[]; information: number[] };
    logger: ReturnType<typeof createRecordingLogger>;
    // 操作の画面を有効にしたときに実行を受け付けた引数
    executed: CliArguments[];
    runner: ReturnType<typeof createJobRunner>;
    behavior: {
        failFetchDates: boolean;
        failSave: boolean;
        failIsSaved: boolean;
        info: Partial<RaceInformation["race"]>;
        races: RaceListItem[];
    };
};

type HarnessOptions = {
    assetsDirectory?: string;
    // 今日の日付(YYYY-MM-DD)
    today?: string;
    // 操作の画面(CLIの全操作)を有効にするか
    hasOperations?: boolean;
};

function createHarness(options: HarnessOptions = {}): Harness {
    const { assetsDirectory } = options;
    const saved: RaceInfoRecord[] = [];
    const savedIds = new Set<number>();
    const calls: Harness["calls"] = { dates: 0, lists: [], information: [] };
    const logger = createRecordingLogger();
    const behavior: Harness["behavior"] = {
        failFetchDates: false,
        failSave: false,
        failIsSaved: false,
        info: {},
        races: RACES,
    };
    const runner = createJobRunner({ logger });
    const executed: CliArguments[] = [];

    const client: NetkeibaClient = {
        fetchRaceDates: async () => {
            calls.dates++;
            if (behavior.failFetchDates) {
                throw new Error("browser crashed");
            }
            return DATES;
        },
        fetchRaceList: async (link) => {
            calls.lists.push(link);
            return behavior.races;
        },
        fetchRaceInformation: async (raceId) => {
            calls.information.push(raceId);
            return information(raceId, behavior.info);
        },
        close: async () => {},
    };
    const dependencies: WebUiDependencies = {
        client,
        logger,
        today: () => options.today ?? "2025-07-01",
        isHostAllowed: (hostname) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname),
        isRaceSaved: async (raceId) => {
            if (behavior.failIsSaved) {
                throw new Error("db down");
            }
            return savedIds.has(raceId);
        },
        saveRaceInfo: async (record) => {
            if (behavior.failSave) {
                throw new Error("varchar overflow");
            }
            saved.push(record);
            savedIds.add(record.id);
        },
        assetsDirectory,
        operations: options.hasOperations
            ? {
                  runner,
                  tempDirectory: "./test-temp",
                  createExecutor: (args) => async () => {
                      executed.push(args);
                  },
              }
            : undefined,
    };
    return { app: createApp(dependencies), saved, savedIds, calls, logger, executed, runner, behavior };
}

const FORM_HEADERS = {
    "content-type": "application/x-www-form-urlencoded",
    origin: "http://localhost",
    host: "localhost",
};

function postSave(harness: Harness, fields: Record<string, string>, headers: Record<string, string> = FORM_HEADERS) {
    return harness.app.request("/save", { method: "POST", headers, body: new URLSearchParams(fields).toString() });
}

let harness: Harness;

beforeEach(() => {
    harness = createHarness();
});

describe("GET /", () => {
    test("shows the first date, race and its details by default", async () => {
        const response = await harness.app.request("/", { headers: { host: "localhost" } });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("7/6(日)");
        expect(html).toContain("2025-07-06 のレース一覧");
        expect(html).toContain("札幌 - 1R  - テスト未勝利");
        expect(html).toContain("出走馬情報");
        expect(harness.calls.information).toEqual([209901010101]);
    });

    test("escapes values that come from the site", async () => {
        const html = await (await harness.app.request("/", { headers: { host: "localhost" } })).text();
        expect(html).not.toContain("<script>alert(1)</script>");
        expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(html).not.toContain("テストホース<b>");
        expect(html).toContain("テストホース&lt;b&gt;");
    });

    test("selects by index and clamps invalid indexes to the first entry", async () => {
        await harness.app.request("/?date=1&race=1", { headers: { host: "localhost" } });
        await harness.app.request("/?date=99&race=abc", { headers: { host: "localhost" } });
        await harness.app.request("/?date=-1&race=1e3", { headers: { host: "localhost" } });
        expect(harness.calls.lists).toEqual([DATES[1]?.href, DATES[0]?.href]);
        expect(harness.calls.information).toEqual([209901010102, 209901010101]);
    });

    test("caches site requests between page views", async () => {
        await harness.app.request("/", { headers: { host: "localhost" } });
        await harness.app.request("/", { headers: { host: "localhost" } });
        expect(harness.calls.dates).toBe(1);
        expect(harness.calls.lists).toHaveLength(1);
        expect(harness.calls.information).toHaveLength(1);
    });

    test("sets restrictive security headers", async () => {
        const response = await harness.app.request("/", { headers: { host: "localhost" } });
        const csp = response.headers.get("content-security-policy") ?? "";
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    });

    test("allows scripts and styles only from the same origin", async () => {
        const response = await harness.app.request("/", { headers: { host: "localhost" } });
        const csp = response.headers.get("content-security-policy") ?? "";
        expect(csp).toContain("script-src 'self'");
        expect(csp).not.toMatch(/script-src[^;]*'unsafe-/);
        expect(csp).toContain("style-src 'self'");
    });

    test("links the client assets and hands the page values to the client as JSON", async () => {
        const html = await (await harness.app.request("/", { headers: { host: "localhost" } })).text();
        expect(html).toContain('href="/assets/app.css"');
        expect(html).toContain('src="/assets/app.js"');
        const match = /<script id="skylark-props" type="application\/json">(.*?)<\/script>/s.exec(html);
        expect(match).not.toBeNull();
        const props = JSON.parse(match?.[1] ?? "null");
        expect(props.dateIndex).toBe(0);
        // サイト由来の値に「<」があっても script 要素を閉じられない 値は元のまま復元できる
        expect(match?.[1]).not.toContain("<");
        expect(props.detail.race.raceName).toBe("テスト未勝利<script>alert(1)</script>");
    });

    test("rejects unexpected Host headers", async () => {
        const response = await harness.app.request("/", { headers: { host: "evil.example" } });
        expect(response.status).toBe(403);
        expect(harness.calls.dates).toBe(0);
    });

    test("accepts localhost with a port and IPv6 loopback", async () => {
        expect((await harness.app.request("/", { headers: { host: "localhost:8501" } })).status).toBe(200);
        expect((await harness.app.request("/", { headers: { host: "127.0.0.1:8501" } })).status).toBe(200);
        expect((await harness.app.request("/", { headers: { host: "[::1]:8501" } })).status).toBe(200);
    });

    test("shows only whitelisted notices and ignores arbitrary text", async () => {
        const known = await (await harness.app.request("/?n=saved", { headers: { host: "localhost" } })).text();
        expect(known).toContain("レース情報をDBへ保管しました。");
        const unknown = await (
            await harness.app.request("/?n=%3Cscript%3Ex%3C/script%3E", { headers: { host: "localhost" } })
        ).text();
        expect(unknown).not.toContain("<script>x</script>");
        const prototypeKey = await (await harness.app.request("/?n=constructor", { headers: { host: "localhost" } }))
            .status;
        expect(prototypeKey).toBe(200);
    });

    test("shows an error notice and logs when the site cannot be reached", async () => {
        harness.behavior.failFetchDates = true;
        const response = await harness.app.request("/", { headers: { host: "localhost" } });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("開催日を取得できませんでした");
        expect(harness.logger.ofLevel("error")[0]).toContain("browser crashed");
    });

    test("keeps working when the DB cannot tell whether the race is saved", async () => {
        harness.behavior.failIsSaved = true;
        const response = await harness.app.request("/", { headers: { host: "localhost" } });
        expect(response.status).toBe(200);
        expect(harness.logger.ofLevel("error")[0]).toContain("db down");
    });

    test("explains why a race cannot be saved when the name is missing", async () => {
        harness.behavior.info = { raceName: null };
        const html = await (await harness.app.request("/", { headers: { host: "localhost" } })).text();
        expect(html).toContain("保管できません");
        expect(html).toContain("disabled");
    });
});

// 表示中のレースだけを予測するフォーム(送信先は操作の画面と同じ POST /operations)
function predictFormOf(html: string): string | null {
    return /<form[^>]*action="\/operations"[^>]*>.*?<\/form>/s.exec(html)?.[0] ?? null;
}

// フォームの隠し項目の値
function hiddenFields(form: string): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const input of form.matchAll(/<input[^>]*>/g)) {
        const name = /name="([^"]*)"/.exec(input[0])?.[1];
        const value = /value="([^"]*)"/.exec(input[0])?.[1];
        if (name != null && value != null) {
            fields[name] = value;
        }
    }
    return fields;
}

describe("GET / predict button", () => {
    const get = async (target: string = "/"): Promise<string> =>
        (await harness.app.request(target, { headers: { host: "localhost" } })).text();

    test("is not shown when the operations screen is disabled", async () => {
        harness = createHarness({ today: "2025-07-06" });
        const html = await get();
        expect(html).not.toContain("このレースを予測");
        expect(predictFormOf(html)).toBeNull();
    });

    test("offers a prediction for the displayed race only on a central race of the day", async () => {
        harness = createHarness({ today: "2025-07-06", hasOperations: true });
        const form = predictFormOf(await get("/?date=0&race=1"));
        expect(form).not.toBeNull();
        expect(form).toContain("このレースを予測");
        expect(form).not.toContain('disabled=""');
        expect(hiddenFields(form ?? "")).toEqual({ predict: "1", raceIds: "209901010102" });
    });

    test("is disabled with a reason when the date is not today", async () => {
        harness = createHarness({ today: "2025-07-01", hasOperations: true });
        const form = predictFormOf(await get());
        expect(form).toContain('disabled=""');
        expect(form).toContain("予測できるのは当日開催のレースだけです。");
    });

    test("is disabled with a reason for a local race", async () => {
        harness = createHarness({ today: "2025-07-06", hasOperations: true });
        harness.behavior.races = [
            {
                courseName: "大井",
                raceNumber: "1R",
                raceName: "地方",
                text: "大井 - 1R  - 地方",
                href: "../race/shutuba.html?race_id=202544010101",
                raceId: 202544010101,
            },
        ];
        const form = predictFormOf(await get());
        expect(form).toContain('disabled=""');
        expect(form).toContain("予測できるのは中央競馬のレースだけです。");
    });

    test("sends exactly the fields that the operations screen accepts to start a prediction", async () => {
        harness = createHarness({ today: "2025-07-06", hasOperations: true });
        const form = predictFormOf(await get("/?date=0&race=1"));
        const response = await harness.app.request("/operations", {
            method: "POST",
            headers: FORM_HEADERS,
            body: new URLSearchParams(hiddenFields(form ?? "")).toString(),
        });
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toMatch(/^\/jobs\/[0-9a-f-]{36}$/);
        await harness.runner.whenIdle();
        expect(harness.executed).toHaveLength(1);
        expect(harness.executed[0]).toMatchObject({
            isPredict: true,
            isScraping: false,
            isFeature: false,
            isTrain: false,
            raceIds: ["209901010102"],
        });
    });
});

describe("POST /save", () => {
    async function view(): Promise<void> {
        await harness.app.request("/?date=0&race=0", { headers: { host: "localhost" } });
    }

    test("saves the displayed race with the date and place from the list", async () => {
        await view();
        const response = await postSave(harness, { raceId: "209901010101", date: "0", race: "0" });
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/?date=0&race=0&n=saved");
        expect(harness.saved).toHaveLength(1);
        expect(harness.saved[0]).toMatchObject({
            id: 209901010101,
            date: "2025-07-06",
            placeDetail: "札幌",
            raceNumber: 1,
            distance: 1200,
            postTime: "09:55",
        });
    });

    test("does not save twice and reports the existing record", async () => {
        await view();
        await postSave(harness, { raceId: "209901010101", date: "0", race: "0" });
        const second = await postSave(harness, { raceId: "209901010101", date: "0", race: "0" });
        expect(second.headers.get("location")).toContain("n=exists");
        expect(harness.saved).toHaveLength(1);
    });

    test("refuses a race that was not displayed (nothing to save from)", async () => {
        const response = await postSave(harness, { raceId: "209901010101", date: "0", race: "0" });
        expect(response.headers.get("location")).toContain("n=expired");
        expect(harness.saved).toHaveLength(0);
    });

    test("ignores any race content sent by the client", async () => {
        await view();
        await postSave(harness, {
            raceId: "209901010101",
            date: "0",
            race: "0",
            raceName: "tampered",
            date_: "1999-01-01",
        });
        expect(harness.saved[0]?.raceName).toContain("テスト未勝利");
    });

    test("rejects malformed race ids", async () => {
        for (const raceId of ["", "abc", "1; DROP TABLE", "-5", "1".repeat(30)]) {
            const response = await postSave(harness, { raceId });
            expect(response.status).toBe(400);
        }
        expect(harness.saved).toHaveLength(0);
    });

    test("reports a save failure without leaking the error", async () => {
        await view();
        harness.behavior.failSave = true;
        const response = await postSave(harness, { raceId: "209901010101", date: "0", race: "0" });
        expect(response.headers.get("location")).toContain("n=failed");
        expect(harness.logger.ofLevel("error")[0]).toContain("varchar overflow");
    });

    test("sanitizes redirect indexes", async () => {
        await view();
        const response = await postSave(harness, { raceId: "209901010101", date: "<x>", race: "99999999999" });
        expect(response.headers.get("location")).toBe("/?date=0&race=0&n=saved");
    });

    test("is rejected for a cross origin request", async () => {
        await view();
        const response = await postSave(
            harness,
            { raceId: "209901010101" },
            { ...FORM_HEADERS, origin: "http://evil.example" },
        );
        expect(response.status).toBe(403);
        expect(harness.saved).toHaveLength(0);
    });

    test("is rejected for an unexpected Host header", async () => {
        await view();
        const response = await postSave(harness, { raceId: "209901010101" }, { ...FORM_HEADERS, host: "evil.example" });
        expect(response.status).toBe(403);
    });
});

describe("GET /assets/:name", () => {
    let assetsDirectory: string;

    beforeEach(async () => {
        assetsDirectory = await mkdtemp(path.join(tmpdir(), "skylark-assets-"));
        await writeFile(path.join(assetsDirectory, "app.js"), "console.log(1);");
        await writeFile(path.join(assetsDirectory, "app.css"), "body{margin:0}");
        await writeFile(path.join(assetsDirectory, "secret.txt"), "secret");
        harness = createHarness({ assetsDirectory });
    });

    afterEach(async () => {
        await rm(assetsDirectory, { recursive: true, force: true });
    });

    test("serves the script and the stylesheet with their content types", async () => {
        const script = await harness.app.request("/assets/app.js", { headers: { host: "localhost" } });
        expect(script.status).toBe(200);
        expect(script.headers.get("content-type")).toContain("text/javascript");
        expect(await script.text()).toBe("console.log(1);");

        const style = await harness.app.request("/assets/app.css", { headers: { host: "localhost" } });
        expect(style.status).toBe(200);
        expect(style.headers.get("content-type")).toContain("text/css");
        expect(await style.text()).toBe("body{margin:0}");
    });

    test("serves only the known file names", async () => {
        for (const name of ["secret.txt", "..%2Fsecret.txt", "..%2F..%2Fetc%2Fpasswd", "constructor", "__proto__"]) {
            const response = await harness.app.request(`/assets/${name}`, { headers: { host: "localhost" } });
            expect(response.status).toBe(404);
        }
    });

    test("answers 404 and logs when the client has not been built", async () => {
        await rm(path.join(assetsDirectory, "app.js"));
        const response = await harness.app.request("/assets/app.js", { headers: { host: "localhost" } });
        expect(response.status).toBe(404);
        expect(harness.logger.ofLevel("error")[0]).toContain("build:webui");
    });

    test("checks the Host header like the pages", async () => {
        const response = await harness.app.request("/assets/app.js", { headers: { host: "evil.example" } });
        expect(response.status).toBe(403);
    });
});

describe("selectionPath", () => {
    test("drops the race number so that a new date starts at its first race", () => {
        expect(selectionPath(2)).toBe("/?date=2");
    });

    test("keeps both numbers when the race is chosen", () => {
        expect(selectionPath(2, 5)).toBe("/?date=2&race=5");
        expect(selectionPath(0, 0)).toBe("/?date=0&race=0");
    });
});
