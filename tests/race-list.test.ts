//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    DB_BASE_URL,
    exportRaceUrlList,
    extractDayListPaths,
    extractRacePaths,
    importRaceUrlList,
    makeRaceUrlList,
    raceUrlPathsFromIds,
} from "../src/scraper/race-list.ts";
import { createRecordingLogger } from "./mock-fetch.ts";

let workDir: string;

beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "skylark-list-"));
});

afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("raceUrlPathsFromIds", () => {
    test("builds result page paths", () => {
        expect(raceUrlPathsFromIds(["202501010101", "202501010102"])).toEqual([
            "/race/202501010101/",
            "/race/202501010102/",
        ]);
    });
});

describe("importRaceUrlList / exportRaceUrlList", () => {
    test("round trips sorted paths and creates the directory", async () => {
        const file = path.join(workDir, "nested", "race_list.txt");
        await exportRaceUrlList(file, ["/race/2/", "/race/1/", "/race/3/"]);
        expect(await Bun.file(file).text()).toBe("/race/1/\n/race/2/\n/race/3/\n");
        expect(await importRaceUrlList(file, createRecordingLogger())).toEqual(["/race/1/", "/race/2/", "/race/3/"]);
    });

    test("leaves no temporary file behind", async () => {
        await exportRaceUrlList(path.join(workDir, "list.txt"), ["/race/1/"]);
        expect(await readdir(workDir)).toEqual(["list.txt"]);
    });

    test("import drops blank lines and surrounding whitespace", async () => {
        const file = path.join(workDir, "list.txt");
        await Bun.write(file, "/race/b/\r\n\n  /race/a/  \n\n");
        expect(await importRaceUrlList(file, createRecordingLogger())).toEqual(["/race/a/", "/race/b/"]);
    });

    test("import logs an error and returns an empty list when the file is missing", async () => {
        const logger = createRecordingLogger();
        expect(await importRaceUrlList(path.join(workDir, "none.txt"), logger)).toEqual([]);
        expect(logger.ofLevel("error")[0]).toContain("file not found");
    });
});

// 月のカレンダー(API応答) 日付ごとのリンクは絶対URLで 見出しの前後の月へのリンクはtableの外にある
const calendarJson = (days: string[], options: { navigationLinks?: string[] } = {}): string =>
    JSON.stringify(`<div class="race_calendar"><dl><dt><ul><li>${(options.navigationLinks ?? [])
        .map((date) => `<a href="${DB_BASE_URL}/race/list/${date}/">nav</a>`)
        .join("")}</li></ul></dt><dd><table><tbody><tr>
<th>月</th><td class="no_day">&nbsp;</td>
${days.map((date) => `<td><a href="${DB_BASE_URL}/race/list/${date}/">${Number(date.slice(6))}</a></td>`).join("\n")}
</tr></tbody></table></dd></dl></div>`);

// 日別一覧 レースへのリンクは絶対URL 一覧の外にも別のレースへのリンクがある
const listPage = (raceIds: string[]): string => `<html><body><div id="contents">
<div id="main"><div class="race_kaisai_info"><div class="race_list fc">
${raceIds.map((id) => `<a href="${DB_BASE_URL}/race/${id}/" title="R">R</a>`).join("\n")}
<a href="${DB_BASE_URL}/race/sum/01/20250726/">summary</a>
<a href="https://other.example/race/999999999999/">other</a>
</div></div></div>
<a href="${DB_BASE_URL}/race/202599999999/">pickup</a>
</div></body></html>`;

const calendarUrl = (yyyymm: string): string =>
    `${DB_BASE_URL}/race/ajax_race_calendar.html?input=UTF-8&output=json&date=${yyyymm}01`;

// 2025-07-27(日) 日本時間の午前 UTCでは前日
const NOW = new Date("2025-07-26T16:30:00Z");

describe("extractRacePaths", () => {
    test("accepts absolute and relative links and ignores other sites and other path forms", () => {
        const html = `<div id="contents"><div id="main"><div class="race_list">
<a href="https://db.netkeiba.com/race/202501010101/">abs</a>
<a href="/race/202501010102/">rel</a>
<a href="https://other.example/race/202501010103/">other site</a>
<a href="/race/sum/01/20250726/">sum</a>
<a href="/race/20250101010/">short</a>
<a>no href</a>
</div></div></div>`;
        expect(extractRacePaths(html)).toEqual(["/race/202501010101/", "/race/202501010102/"]);
    });

    test("excludes Banei (place code 65) races", () => {
        const html = `<div id="contents"><div id="main"><div class="race_list">
<a href="https://db.netkeiba.com/race/202665100301/">banei</a>
<a href="https://db.netkeiba.com/race/202654100301/">kochi</a>
<a href="https://db.netkeiba.com/race/202605040101/">tokyo</a>
</div></div></div>`;
        expect(extractRacePaths(html)).toEqual(["/race/202654100301/", "/race/202605040101/"]);
    });

    test("drops duplicates and links outside the race list", () => {
        const html = `<div id="contents"><div id="main"><div class="race_list">
<a href="/race/202501010101/">a</a><a href="/race/202501010101/">again</a></div></div>
<a href="/race/202501010199/">outside</a></div>`;
        expect(extractRacePaths(html)).toEqual(["/race/202501010101/"]);
    });
});

describe("extractDayListPaths", () => {
    test("keeps days of the month up to the last date and ignores navigation links", () => {
        const html = JSON.parse(
            calendarJson(["20250725", "20250726", "20250727", "20250728"], { navigationLinks: ["20250627"] }),
        );
        expect(extractDayListPaths(html, { year: 2025, month: 7 }, "20250727")).toEqual([
            "/race/list/20250725/",
            "/race/list/20250726/",
            "/race/list/20250727/",
        ]);
    });

    test("ignores links of another month", () => {
        const html = JSON.parse(calendarJson(["20250630", "20250701"]));
        expect(extractDayListPaths(html, { year: 2025, month: 7 }, "20251231")).toEqual(["/race/list/20250701/"]);
    });
});

describe("makeRaceUrlList", () => {
    test("collects result paths from each daily list of the month", async () => {
        const pages: Record<string, string> = {
            [calendarUrl("202507")]: calendarJson(["20250726", "20250727"]),
            [`${DB_BASE_URL}/race/list/20250726/`]: listPage(["202501010101", "202501010102"]),
            [`${DB_BASE_URL}/race/list/20250727/`]: listPage(["202501010201"]),
        };
        const paths = await makeRaceUrlList(1, {
            logger: createRecordingLogger(),
            fetchHtml: async (url) => pages[url] ?? "",
            sleep: async () => {},
            now: NOW,
        });
        expect(paths).toEqual(["/race/202501010101/", "/race/202501010102/", "/race/202501010201/"]);
    });

    test("walks back month by month across a year boundary without following site links", async () => {
        const requested: string[] = [];
        await makeRaceUrlList(3, {
            logger: createRecordingLogger(),
            fetchHtml: async (url) => {
                requested.push(url);
                return calendarJson([]);
            },
            sleep: async () => {},
            now: new Date("2026-01-15T03:00:00Z"),
        });
        expect(requested).toEqual([calendarUrl("202601"), calendarUrl("202512"), calendarUrl("202511")]);
    });

    test("decides today in Japan time and does not request days after it", async () => {
        const requested: string[] = [];
        await makeRaceUrlList(1, {
            logger: createRecordingLogger(),
            fetchHtml: async (url) => {
                requested.push(url);
                return url.includes("ajax_race_calendar")
                    ? calendarJson(["20250726", "20250727", "20250728"])
                    : listPage([]);
            },
            sleep: async () => {},
            now: NOW,
        });
        expect(requested).toEqual([
            calendarUrl("202507"),
            `${DB_BASE_URL}/race/list/20250726/`,
            `${DB_BASE_URL}/race/list/20250727/`,
        ]);
    });

    test("drops a race that appears in several daily lists", async () => {
        const pages: Record<string, string> = {
            [calendarUrl("202507")]: calendarJson(["20250726", "20250727"]),
            [`${DB_BASE_URL}/race/list/20250726/`]: listPage(["202501010101"]),
            [`${DB_BASE_URL}/race/list/20250727/`]: listPage(["202501010101"]),
        };
        const paths = await makeRaceUrlList(1, {
            logger: createRecordingLogger(),
            fetchHtml: async (url) => pages[url] ?? "",
            sleep: async () => {},
            now: NOW,
        });
        expect(paths).toEqual(["/race/202501010101/"]);
    });

    test("retries an empty daily list after waiting, then skips it, reports it and continues", async () => {
        const waits: number[] = [];
        const logger = createRecordingLogger();
        const pages: Record<string, string> = {
            [calendarUrl("202507")]: calendarJson(["20250726", "20250727"]),
            [`${DB_BASE_URL}/race/list/20250726/`]: "",
            [`${DB_BASE_URL}/race/list/20250727/`]: listPage(["202501010201"]),
        };
        const paths = await makeRaceUrlList(1, {
            logger,
            fetchHtml: async (url) => pages[url] ?? "",
            sleep: async (milliseconds) => {
                waits.push(milliseconds);
            },
            now: NOW,
            requestDelayMilliseconds: 10,
        });
        expect(paths).toEqual(["/race/202501010201/"]);
        // 月の取得後 空の応答から再試行までの間(2回) 次の日の一覧の取得後(最後の試行の後は待たない)
        expect(waits).toEqual([10, 3000, 3000, 10]);
        const warnings = logger.ofLevel("warning").join("\n");
        expect(warnings).toContain("skip race list: /race/list/20250726/");
        expect(warnings).toContain("race list is incomplete, 1 day(s) skipped: /race/list/20250726/");
    });

    test("succeeds when a daily list is slow on the first attempts and reports nothing", async () => {
        const logger = createRecordingLogger();
        let attempts = 0;
        const paths = await makeRaceUrlList(1, {
            logger,
            fetchHtml: async (url) => {
                if (url.includes("ajax_race_calendar")) {
                    return calendarJson(["20250727"]);
                }
                attempts++;
                if (attempts < 3) {
                    throw new Error("timed out");
                }
                return listPage(["202501010201"]);
            },
            sleep: async () => {},
            now: NOW,
        });
        expect(paths).toEqual(["/race/202501010201/"]);
        expect(logger.ofLevel("warning").join("\n")).not.toContain("incomplete");
    });

    test("waits between requests to spare the server", async () => {
        const waits: number[] = [];
        await makeRaceUrlList(1, {
            logger: createRecordingLogger(),
            fetchHtml: async (url) => (url.includes("ajax_race_calendar") ? calendarJson(["20250727"]) : listPage([])),
            sleep: async (milliseconds) => {
                waits.push(milliseconds);
            },
            now: NOW,
        });
        expect(waits).toEqual([500, 500]);
    });

    test("skips a month whose calendar cannot be read and still collects the others", async () => {
        const logger = createRecordingLogger();
        const pages: Record<string, string> = {
            [calendarUrl("202507")]: "<html>not json</html>",
            [calendarUrl("202506")]: calendarJson(["20250601"]),
            [`${DB_BASE_URL}/race/list/20250601/`]: listPage(["202501010101"]),
        };
        const paths = await makeRaceUrlList(2, {
            logger,
            fetchHtml: async (url) => pages[url] ?? "",
            sleep: async () => {},
            now: NOW,
        });
        expect(paths).toEqual(["/race/202501010101/"]);
        expect(logger.ofLevel("error").join("\n")).toContain("calendar not available: 2025-07");
    });

    test("gives up after repeated months without a calendar instead of looping", async () => {
        const logger = createRecordingLogger();
        const requested: string[] = [];
        const paths = await makeRaceUrlList(12, {
            logger,
            fetchHtml: async (url) => {
                requested.push(url);
                return "";
            },
            sleep: async () => {},
            now: NOW,
        });
        expect(paths).toEqual([]);
        // 1か月につき3回試す
        expect(requested).toHaveLength(9);
        expect(logger.ofLevel("error").join("\n")).toContain("giving up");
    });

    test("logs and skips when requests keep failing", async () => {
        const logger = createRecordingLogger();
        const paths = await makeRaceUrlList(3, {
            logger,
            fetchHtml: async () => {
                throw new Error("network down");
            },
            sleep: async () => {},
            now: NOW,
        });
        expect(paths).toEqual([]);
        expect(logger.ofLevel("warning")[0]).toContain("network down");
        expect(logger.ofLevel("error").join("\n")).toContain("giving up");
    });

    test("does nothing for zero months", async () => {
        let called = false;
        const paths = await makeRaceUrlList(0, {
            logger: createRecordingLogger(),
            fetchHtml: async () => {
                called = true;
                return "";
            },
            now: NOW,
        });
        expect(paths).toEqual([]);
        expect(called).toBe(false);
    });
});
