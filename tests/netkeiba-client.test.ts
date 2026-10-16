//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { chromium } from "playwright";

import {
    createNetkeibaClient,
    extractKaisaiDateFromUrl,
    extractRaceIdFromUrl,
    type NetkeibaClient,
} from "../src/webui/netkeiba-client.ts";

describe("extractRaceIdFromUrl", () => {
    test("extracts the id from a query string", () => {
        expect(extractRaceIdFromUrl("../race/shutuba.html?race_id=202501010101&rf=race_list")).toBe(202501010101);
    });

    test("returns null without race_id", () => {
        expect(extractRaceIdFromUrl("/race/list/")).toBeNull();
        expect(extractRaceIdFromUrl("?race_id=abc")).toBeNull();
    });
});

describe("extractKaisaiDateFromUrl", () => {
    test("formats the date with zero padding", () => {
        expect(extractKaisaiDateFromUrl("race_list.html?kaisai_date=20250706")).toBe("2025-07-06");
    });

    test("returns null for malformed or missing values", () => {
        expect(extractKaisaiDateFromUrl("race_list.html")).toBeNull();
        expect(extractKaisaiDateFromUrl("race_list.html?kaisai_date=2025")).toBeNull();
    });
});

// ---- 実ブラウザを使う検証 ブラウザが無い環境では丸ごとスキップする ----

const chromiumExecutablePath = process.env.CHROMIUM_EXECUTABLE_PATH;

async function canLaunchBrowser(): Promise<boolean> {
    try {
        const browser = await chromium.launch({
            headless: true,
            executablePath: chromiumExecutablePath === "" ? undefined : chromiumExecutablePath,
        });
        await browser.close();
        return true;
    } catch {
        return false;
    }
}

const isBrowserAvailable = await canLaunchBrowser();

const RACE_LIST_PAGE = `<!DOCTYPE html><html><body>
<ul id="date_list_sub">
<li><a href="race_list.html?kaisai_date=20250101"> 1/1(水) </a></li>
<li><a href="race_list.html?kaisai_date=20250706">7/6(日)</a></li>
<li><a href="race_list.html?kaisai_date=20250713">7/13(日)</a></li>
<li><a href="race_list.html">日付なし</a></li>
<li><a href="">空のリンク</a></li>
<li><a href="race_list.html?kaisai_date=20250720">   </a></li>
</ul></body></html>`;

const DAY_PAGE = `<!DOCTYPE html><html><body>
<dl class="RaceList_DataList">
<dt><p class="RaceList_DataTitle">1回 札幌 1日目</p></dt>
<dd><ul>
<li class="RaceList_DataItem"><a href="../race/shutuba.html?race_id=209901010101&rf=x"><div class="Race_Num">1R</div><div class="RaceList_ItemTitle"><span class="ItemTitle">テスト未勝利</span></div></a></li>
<li class="RaceList_DataItem"><a href="../race/shutuba.html?race_id=209901010102"><div class="Race_Num">10R</div></a></li>
<li class="RaceList_DataItem"><a href="/other/page.html"><div class="Race_Num">2R</div><div class="RaceList_ItemTitle"><span class="ItemTitle">別サイト</span></div></a></li>
</ul></dd>
</dl>
<dl class="RaceList_DataList">
<dt><p class="RaceList_DataTitle">2回 函館 1日目</p></dt>
<dd><ul>
<li class="RaceList_DataItem"><a href="../race/shutuba.html?race_id=209902010101"><div class="Race_Num">1R</div><div class="RaceList_ItemTitle"><span class="ItemTitle">函館戦</span></div></a></li>
</ul></dd>
</dl></body></html>`;

function horseRow(
    overrides: {
        waku?: string;
        number?: string;
        weight?: string;
        odds?: string;
        popularity?: string;
        bodyWeight?: string;
        cells?: number;
    } = {},
): string {
    const cells = [
        `<td>${overrides.waku ?? "2"}</td>`,
        `<td>${overrides.number ?? "3"}</td>`,
        "<td>印</td>",
        '<td><a href="https://db.netkeiba.com/horse/2099100001">テストホースA</a></td>',
        "<td>牝2</td>",
        `<td>${overrides.weight ?? "55.0"}</td>`,
        '<td><a href="https://db.netkeiba.com/jockey/result/recent/01001/">騎手A</a></td>',
        '<td><a href="https://db.netkeiba.com/trainer/result/recent/01002/">調教師A</a></td>',
        `<td>${overrides.bodyWeight ?? "408(+4)"}</td>`,
        `<td><span>${overrides.odds ?? "4.8"}</span></td>`,
        `<td><span>${overrides.popularity ?? "3"}</span></td>`,
        "<td>-</td>",
        "<td>-</td>",
        "<td>-</td>",
    ];
    return `<tr class="HorseList">${cells.slice(0, overrides.cells ?? cells.length).join("")}</tr>`;
}

const SHUTUBA_PAGE = `<!DOCTYPE html><html><body><div id="page">
<div class="RaceColumn01"><div><div class="RaceMainColumn">
<div class="RaceList_NameBox">
<div class="RaceList_Item01"><span class="RaceNum">11R</span></div>
<div class="RaceList_Item02"><h1>テスト記念</h1></div>
</div></div></div></div>
<div class="RaceData01">09:55発走 / 芝1200m (右 外) / 天候:曇 / 馬場:良</div>
<div class="RaceData02"><span>1回</span> <span>札幌</span> <span>1日目</span> サラ系２歳 未勝利 (混)[指] 馬齢 16頭</div>
<table class="Shutuba_Table"><tbody>
${horseRow()}
${horseRow({ waku: "", number: "4", weight: "未定", odds: "---", popularity: "**", bodyWeight: "計不" })}
${horseRow({ number: "9", cells: 5 })}
</tbody></table></div></body></html>`;

describe.skipIf(!isBrowserAvailable)("createNetkeibaClient (real Chromium against a local fixture site)", () => {
    let server: ReturnType<typeof Bun.serve>;
    let client: NetkeibaClient;

    beforeAll(() => {
        server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                const url = new URL(request.url);
                const html = (body: string) =>
                    new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
                if (url.pathname === "/top/race_list.html") {
                    return html(RACE_LIST_PAGE);
                }
                if (url.pathname === "/top/day.html") {
                    return html(DAY_PAGE);
                }
                if (url.pathname === "/race/shutuba.html") {
                    return html(SHUTUBA_PAGE);
                }
                if (url.pathname === "/top/empty.html") {
                    return html("<html><body>nothing</body></html>");
                }
                return new Response("not found", { status: 404 });
            },
        });
        client = createNetkeibaClient({
            baseUrl: `http://127.0.0.1:${server.port}`,
            executablePath: chromiumExecutablePath === "" ? undefined : chromiumExecutablePath,
        });
    });

    afterAll(async () => {
        await client.close();
        await server.stop(true);
    });

    test("fetchRaceDates keeps today and later, and drops entries without a link or text", async () => {
        const dates = await client.fetchRaceDates("2025-07-06");
        expect(dates).toEqual([
            { text: "7/6(日)", href: "race_list.html?kaisai_date=20250706", kaisaiDate: "2025-07-06" },
            { text: "7/13(日)", href: "race_list.html?kaisai_date=20250713", kaisaiDate: "2025-07-13" },
            { text: "日付なし", href: "race_list.html", kaisaiDate: null },
        ]);
    });

    test("fetchRaceList lists races of every course with ids", async () => {
        const races = await client.fetchRaceList("day.html");
        expect(races.map((race) => race.text)).toEqual([
            "1回 札幌 1日目 - 1R  - テスト未勝利",
            "1回 札幌 1日目 - 10R - （名称不明）",
            "2回 函館 1日目 - 1R  - 函館戦",
        ]);
        expect(races.map((race) => race.raceId)).toEqual([209901010101, 209901010102, 209902010101]);
        expect(races[0]?.courseName).toBe("1回 札幌 1日目");
    });

    test("fetchRaceList resolves relative links against the site and accepts absolute urls", async () => {
        const absolute = await client.fetchRaceList(`http://127.0.0.1:${server.port}/top/day.html`);
        expect(absolute).toHaveLength(3);
        const leadingSlash = await client.fetchRaceList("/day.html");
        expect(leadingSlash).toHaveLength(3);
    });

    test("fetchRaceInformation extracts race fields", async () => {
        const { race } = await client.fetchRaceInformation(209901010111);
        expect(race).toEqual({
            id: 209901010111,
            raceName: "テスト記念",
            distance: 1200,
            weather: "曇",
            postTime: "09:55",
            raceNumber: 11,
            runDirection: "右",
            trackSurface: "芝",
            trackCondition: "良",
            trackConditionScore: null,
            raceGrade: 4,
            raceClass: "サラ系２歳 未勝利",
        });
    });

    test("fetchRaceInformation extracts starters and keeps leading zeros of ids", async () => {
        const { horses } = await client.fetchRaceInformation(209901010111);
        expect(horses).toHaveLength(2);
        expect(horses[0]).toEqual({
            horseId: 2099100001,
            horseNumber: 3,
            wakuNumber: 2,
            horseName: "テストホースA",
            barei: "牝2",
            basisWeight: 55,
            jockeyId: "01001",
            jockeyName: "騎手A",
            trainerId: "01002",
            trainerName: "調教師A",
            odds: 4.8,
            popularity: 3,
            horseWeight: 408,
            horseWeightDiff: 4,
        });
    });

    test("fetchRaceInformation tolerates undecided values instead of crashing", async () => {
        const { horses } = await client.fetchRaceInformation(209901010111);
        expect(horses[1]).toMatchObject({
            horseNumber: 4,
            wakuNumber: null,
            basisWeight: null,
            odds: null,
            popularity: null,
            horseWeight: 999,
            horseWeightDiff: 0,
        });
    });

    test("fails with a timeout when the expected element never appears", async () => {
        await expect(client.fetchRaceList("empty.html")).rejects.toThrow();
    }, 20_000);

    test("close is safe to call twice", async () => {
        const another = createNetkeibaClient({
            baseUrl: `http://127.0.0.1:${server.port}`,
            executablePath: chromiumExecutablePath === "" ? undefined : chromiumExecutablePath,
        });
        await another.fetchRaceDates("2025-01-01");
        await another.close();
        await another.close();
    });
});
