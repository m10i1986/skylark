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

const monthPage = (previous: string): string => `<html><body><div id="contents">
<table><tr>
<td><a href="/race/list/20250726/">26</a></td>
<td><a href="/race/list/20250727/">27</a></td>
<td><a href="/race/list/bad/">x</a></td>
<td><a href="/other/">y</a></td>
</tr></table>
<div class="race_calendar"><ul><li><a href="/?pid=race_top&date=next">next</a></li><li><a href="${previous}">prev</a></li></ul></div>
</div></body></html>`;

const listPage = (raceIds: string[], previous: string | null): string => `<html><body><div id="contents">
<div id="main"><div class="race_list">
${raceIds.map((id) => `<a href="/race/${id}/">R</a>`).join("\n")}
<a href="/race/sum/01/20250726/">summary</a>
</div></div>
${previous == null ? "" : `<div class="race_calendar"><ul><li><a href="/x">n</a></li><li><a href="${previous}">p</a></li></ul></div>`}
</div></body></html>`;

describe("makeRaceUrlList", () => {
    test("collects only 12 digit result paths from each daily list", async () => {
        const logger = createRecordingLogger();
        const pages: Record<string, string> = {
            [`${DB_BASE_URL}/?pid=race_top`]: monthPage("/?pid=race_top&date=prev"),
            [`${DB_BASE_URL}/race/list/20250726/`]: listPage(
                ["202501010101", "202501010102"],
                "/?pid=race_top&date=prev",
            ),
            [`${DB_BASE_URL}/race/list/20250727/`]: listPage(["202501010201"], "/?pid=race_top&date=prev"),
        };
        const paths = await makeRaceUrlList(1, { logger, fetchHtml: async (url) => pages[url] ?? "" });
        expect(paths).toEqual(["/race/202501010101/", "/race/202501010102/", "/race/202501010201/"]);
    });

    test("takes the next month link from the last daily list page like the original", async () => {
        const requested: string[] = [];
        const pages: Record<string, string> = {
            [`${DB_BASE_URL}/?pid=race_top`]: monthPage("/?pid=race_top&date=FROM_MONTH_PAGE"),
            [`${DB_BASE_URL}/race/list/20250726/`]: listPage(["202501010101"], "/?pid=race_top&date=FROM_LIST_26"),
            [`${DB_BASE_URL}/race/list/20250727/`]: listPage(["202501010201"], "/?pid=race_top&date=FROM_LIST_27"),
            [`${DB_BASE_URL}/?pid=race_top&date=FROM_LIST_27`]: "<html><body></body></html>",
        };
        await makeRaceUrlList(2, {
            logger: createRecordingLogger(),
            fetchHtml: async (url) => {
                requested.push(url);
                return pages[url] ?? "";
            },
            sleep: async () => {},
        });
        expect(requested.at(-1)).toBe(`${DB_BASE_URL}/?pid=race_top&date=FROM_LIST_27`);
    });

    test("falls back to the month page when the daily list cannot be fetched, waiting between attempts", async () => {
        const waits: number[] = [];
        const logger = createRecordingLogger();
        const pages: Record<string, string> = {
            [`${DB_BASE_URL}/?pid=race_top`]: monthPage("/?pid=race_top&date=FROM_MONTH_PAGE"),
            [`${DB_BASE_URL}/race/list/20250726/`]: "",
            [`${DB_BASE_URL}/race/list/20250727/`]: "",
        };
        const requested: string[] = [];
        const paths = await makeRaceUrlList(2, {
            logger,
            fetchHtml: async (url) => {
                requested.push(url);
                return pages[url] ?? "<html></html>";
            },
            sleep: async (milliseconds) => {
                waits.push(milliseconds);
            },
        });
        expect(paths).toEqual([]);
        expect(waits).toEqual([3000, 3000, 3000, 3000]);
        expect(requested).toContain(`${DB_BASE_URL}/?pid=race_top&date=FROM_MONTH_PAGE`);
    });

    test("gives up after repeated empty responses instead of looping forever", async () => {
        const logger = createRecordingLogger();
        let calls = 0;
        const paths = await makeRaceUrlList(12, {
            logger,
            fetchHtml: async () => {
                calls++;
                return "";
            },
        });
        expect(paths).toEqual([]);
        expect(calls).toBe(3);
        expect(logger.ofLevel("error")[0]).toContain("giving up");
    });

    test("returns what it has and logs when the month page request fails", async () => {
        const logger = createRecordingLogger();
        const paths = await makeRaceUrlList(3, {
            logger,
            fetchHtml: async () => {
                throw new Error("network down");
            },
        });
        expect(paths).toEqual([]);
        expect(logger.ofLevel("error")[0]).toContain("network down");
    });

    test("stops with a warning when there is no previous month link", async () => {
        const logger = createRecordingLogger();
        const calls: string[] = [];
        await makeRaceUrlList(5, {
            logger,
            fetchHtml: async (url) => {
                calls.push(url);
                return "<html><body><div id='contents'></div></body></html>";
            },
        });
        expect(calls).toHaveLength(1);
        expect(logger.ofLevel("warning").join("\n")).toContain("previous month link not found");
    });

    test("does nothing for zero months", async () => {
        let called = false;
        const paths = await makeRaceUrlList(0, {
            logger: createRecordingLogger(),
            fetchHtml: async () => {
                called = true;
                return "";
            },
        });
        expect(paths).toEqual([]);
        expect(called).toBe(false);
    });
});
