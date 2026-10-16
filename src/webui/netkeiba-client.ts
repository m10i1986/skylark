//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

// race.netkeiba.com の出馬表を ヘッドレスブラウザで取得する
// 一覧ページは JavaScript で描画されるため HTTP の取得だけでは内容が得られない

import { type Browser, chromium, type ElementHandle, type Page } from "playwright";

import type { RaceInfoRecord } from "../db/schema.ts";
import { padTwoDigits, parsePyFloat, parsePyInt } from "../scraper/py-compat.ts";
import { raceClassToInt } from "../util.ts";

/** 出馬表サイトのURL */
export const DEFAULT_RACE_SITE_URL = "https://race.netkeiba.com";

/** 開催日の選択肢 */
export type RaceDate = {
    text: string;
    href: string;
    // 開催日(YYYY-MM-DD) 取り出せない場合はnull
    kaisaiDate: string | null;
};

/** 開催日ごとのレースの選択肢 */
export type RaceListItem = {
    courseName: string;
    raceNumber: string;
    raceName: string;
    text: string;
    href: string;
    raceId: number | null;
};

/** 出馬表の1頭分 */
export type HorseEntry = {
    horseId: number | null;
    horseNumber: number | null;
    wakuNumber: number | null;
    horseName: string | null;
    barei: string | null;
    basisWeight: number | null;
    // 騎手と調教師の識別子は先頭の0を保つため文字列
    jockeyId: string | null;
    jockeyName: string | null;
    trainerId: string | null;
    trainerName: string | null;
    odds: number | null;
    popularity: number | null;
    horseWeight: number;
    horseWeightDiff: number;
};

/** DBへ保存する前のレース情報 開催日と開催場所は一覧側の情報で補う */
export type RaceInfoDraft = Omit<RaceInfoRecord, "date" | "placeDetail" | "raceName" | "raceNumber"> & {
    raceName: string | null;
    raceNumber: number | null;
};

/** 1レース分の出馬表 */
export type RaceInformation = {
    race: RaceInfoDraft;
    horses: HorseEntry[];
};

/** 出馬表サイトの取得処理 */
export type NetkeibaClient = {
    // today(YYYY-MM-DD)以降の開催日を返す
    fetchRaceDates(today: string): Promise<RaceDate[]>;
    fetchRaceList(link: string): Promise<RaceListItem[]>;
    fetchRaceInformation(raceId: number): Promise<RaceInformation>;
    close(): Promise<void>;
};

/** ブラウザ起動の設定 */
export type NetkeibaClientOptions = {
    baseUrl?: string;
    // Chromiumの実行ファイル 省略時はPlaywrightが管理するブラウザを使う
    executablePath?: string;
};

/**
 * URLからレースIDを取り出す
 *
 * @param url - race_id=<数字> を含むURL
 * @returns レースID 無い場合はnull
 */
export function extractRaceIdFromUrl(url: string): number | null {
    const match = /race_id=(\d+)/.exec(url);
    return match?.[1] == null ? null : Number(match[1]);
}

/**
 * URLから開催日を取り出す
 *
 * @param url - kaisai_date=YYYYMMDD を含むURL
 * @returns 開催日(YYYY-MM-DD) 無い場合はnull
 */
export function extractKaisaiDateFromUrl(url: string): string | null {
    const match = /kaisai_date=(\d{4})(\d{2})(\d{2})/.exec(url);
    return match == null ? null : `${match[1]}-${match[2]}-${match[3]}`;
}

async function innerTextOf(element: ElementHandle | null): Promise<string | null> {
    return element == null ? null : (await element.innerText()).trim();
}

async function hrefOf(element: ElementHandle | null): Promise<string | null> {
    return element == null ? null : await element.getAttribute("href");
}

// 先頭の0を保つため /<数字>/ 形式のURL末尾から識別子を文字列のまま取り出す
function trailingIdFrom(href: string | null, pattern: RegExp): string | null {
    return href == null ? null : (pattern.exec(href)?.[1] ?? null);
}

async function parseHorseRow(row: ElementHandle): Promise<HorseEntry | null> {
    const cells = await row.$$("td");
    if (cells.length < 14) {
        // 不正な行はスキップ
        return null;
    }
    const cell = (index: number): ElementHandle | null => cells[index] ?? null;

    const horseLink = (await cell(3)?.$("a")) ?? null;
    const jockeyLink = (await cell(6)?.$("a")) ?? null;
    const trainerLink = (await cell(7)?.$("a")) ?? null;
    const horseId = trailingIdFrom(await hrefOf(horseLink), /\/(\d+)$/);

    // 馬体重 例: 480(+4) 取得できない場合は 999 と 0
    let horseWeight = 999;
    let horseWeightDiff = 0;
    const weightMatch = /^(\d+)\(([+-]?\d+)\)/.exec((await innerTextOf(cell(8))) ?? "");
    if (weightMatch) {
        horseWeight = Number(weightMatch[1]);
        horseWeightDiff = Number(weightMatch[2]);
    }

    // 斤量が「未定」などで数値でない場合は欠損として扱う
    const basisWeightText = (await innerTextOf(cell(5))) ?? "";

    return {
        horseId: horseId == null ? null : Number(horseId),
        horseNumber: parsePyInt((await innerTextOf(cell(1))) ?? ""),
        wakuNumber: parsePyInt((await innerTextOf(cell(0))) ?? ""),
        horseName: await innerTextOf(horseLink),
        barei: await innerTextOf(cell(4)),
        basisWeight: parsePyFloat(basisWeightText),
        jockeyId: trailingIdFrom(await hrefOf(jockeyLink), /\/(\d+)\/$/),
        jockeyName: await innerTextOf(jockeyLink),
        trainerId: trailingIdFrom(await hrefOf(trainerLink), /\/(\d+)\/$/),
        trainerName: await innerTextOf(trainerLink),
        // オッズや人気は発売前だと「---」になる
        odds: parsePyFloat((await innerTextOf((await cell(9)?.$("span")) ?? null)) ?? ""),
        popularity: parsePyFloat((await innerTextOf((await cell(10)?.$("span")) ?? null)) ?? ""),
        horseWeight,
        horseWeightDiff,
    };
}

async function parseRaceInformation(page: Page, raceId: number): Promise<RaceInformation> {
    const nameBox = "#page > div.RaceColumn01 > div > div.RaceMainColumn > div.RaceList_NameBox";
    const raceName = await innerTextOf(await page.$(`${nameBox} > div.RaceList_Item02 > h1`));

    const raceNumberText = (await innerTextOf(await page.$(`${nameBox} > div.RaceList_Item01 > span.RaceNum`))) ?? "";
    const raceNumberMatch = /^(\d+)R/.exec(raceNumberText);
    const raceNumber = raceNumberMatch?.[1] == null ? null : Number(raceNumberMatch[1]);

    const raceData1 = (await innerTextOf(await page.$("div.RaceData01"))) ?? "";

    let postTime: string | null = null;
    const postTimeMatch = /(\d{1,2}):(\d{1,2})発走/.exec(raceData1);
    if (postTimeMatch) {
        postTime = `${padTwoDigits(postTimeMatch[1] ?? "")}:${padTwoDigits(postTimeMatch[2] ?? "")}`;
    }

    let distance: number | null = null;
    let trackSurface: string | null = null;
    let runDirection: string | null = null;
    const courseMatch = /(芝|ダ|障)(\d+)m\s+\((左|右|直線).*\)/.exec(raceData1);
    if (courseMatch) {
        const surfaces: Record<string, string> = { 芝: "芝", ダ: "ダート", 障: "障害" };
        trackSurface = surfaces[courseMatch[1] ?? ""] ?? null;
        distance = Number(courseMatch[2]);
        runDirection = courseMatch[3] ?? null;
    }

    const weather = /天候:([^\s]+)/.exec(raceData1)?.[1]?.trim() ?? null;
    const trackCondition = /馬場:([^\s]+)/.exec(raceData1)?.[1]?.trim() ?? null;

    const raceData2 = (await innerTextOf(await page.$("div.RaceData02"))) ?? "";

    const horses: HorseEntry[] = [];
    for (const row of await page.$$("table.Shutuba_Table tbody tr.HorseList")) {
        const horse = await parseHorseRow(row);
        if (horse != null) {
            horses.push(horse);
        }
    }

    return {
        race: {
            id: raceId,
            raceName,
            distance,
            weather,
            postTime,
            raceNumber,
            runDirection,
            trackSurface,
            trackCondition,
            trackConditionScore: null,
            raceGrade: raceClassToInt(raceData2),
            raceClass: raceData2.split(" ").slice(3, 5).join(" "),
        },
        horses,
    };
}

/**
 * 出馬表サイトの取得処理を作る
 *
 * ブラウザは最初の取得時に起動して使い回す 終了時は close() を呼ぶ
 *
 * @param options - 取得先とブラウザの設定
 * @returns 取得処理
 */
export function createNetkeibaClient(options: NetkeibaClientOptions = {}): NetkeibaClient {
    const baseUrl = options.baseUrl ?? DEFAULT_RACE_SITE_URL;
    let browserPromise: Promise<Browser> | null = null;

    const getBrowser = (): Promise<Browser> => {
        browserPromise ??= chromium.launch({ headless: true, executablePath: options.executablePath });
        return browserPromise;
    };

    // ページを開いて処理し 必ず閉じる
    const withPage = async <T>(url: string, selector: string, timeoutMs: number, task: (page: Page) => Promise<T>) => {
        const browser = await getBrowser();
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            await page.goto(url, { waitUntil: "domcontentloaded" });
            await page.waitForSelector(selector, { timeout: timeoutMs });
            return await task(page);
        } finally {
            await context.close();
        }
    };

    return {
        async fetchRaceDates(today) {
            return withPage(`${baseUrl}/top/race_list.html`, "ul#date_list_sub", 10_000, async (page) => {
                const dates: RaceDate[] = [];
                for (const anchor of await page.$$("ul#date_list_sub a")) {
                    const text = ((await anchor.innerText()) ?? "").trim();
                    const href = await anchor.getAttribute("href");
                    if (text === "" || href == null || href === "") {
                        continue;
                    }
                    const kaisaiDate = extractKaisaiDateFromUrl(href);
                    // 開催日が今日以降のみを対象とする
                    if (kaisaiDate != null && kaisaiDate < today) {
                        continue;
                    }
                    dates.push({ text, href, kaisaiDate });
                }
                return dates;
            });
        },

        async fetchRaceList(link) {
            const url = link.startsWith("http") ? link : `${baseUrl}/top/${link.replace(/^\/+/, "")}`;
            return withPage(url, "dl.RaceList_DataList", 10_000, async (page) => {
                const races: RaceListItem[] = [];
                for (const list of await page.$$("dl.RaceList_DataList")) {
                    const courseName = (await innerTextOf(await list.$("p.RaceList_DataTitle"))) ?? "";
                    for (const item of await list.$$("li.RaceList_DataItem")) {
                        const raceNumber = (await innerTextOf(await item.$("div.Race_Num"))) ?? "";
                        const raceName =
                            (await innerTextOf(await item.$("div.RaceList_ItemTitle span.ItemTitle"))) ??
                            "（名称不明）";
                        const href = await hrefOf(await item.$("a"));
                        if (raceName !== "" && href != null && href.includes("/race/")) {
                            races.push({
                                courseName,
                                raceNumber,
                                raceName,
                                text: `${courseName} - ${raceNumber.padEnd(3)} - ${raceName}`,
                                href,
                                raceId: extractRaceIdFromUrl(href),
                            });
                        }
                    }
                }
                return races;
            });
        },

        async fetchRaceInformation(raceId) {
            const url = `${baseUrl}/race/shutuba.html?race_id=${raceId}`;
            return withPage(url, "table.Shutuba_Table tbody tr.HorseList", 20_000, (page) =>
                parseRaceInformation(page, raceId),
            );
        },

        async close() {
            if (browserPromise != null) {
                const browser = await browserPromise;
                browserPromise = null;
                await browser.close();
            }
        },
    };
}
