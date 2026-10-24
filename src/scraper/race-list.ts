//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { mkdir, rename } from "node:fs/promises";
import path from "node:path";

import { load } from "cheerio";

import { sleep } from "../concurrency.ts";
import { describeError, type Logger } from "../logger.ts";

/** レース結果データベースのURL */
export const DB_BASE_URL = "https://db.netkeiba.com";

const RACE_PATH_PATTERN = /^\/race\/(\d{12})\/$/;
const RACE_LIST_PATH_PATTERN = /^\/race\/list\/(\d{8})\/$/;

// 対象外の場コード(レースIDの5〜6桁目) 65=ばんえい競馬 馬IDが英数字(例: B202300104)で保存できない
const EXCLUDED_PLACE_CODES: ReadonlySet<string> = new Set(["65"]);

// 月のレース開催カレンダー(HTMLを文字列としてJSONへ入れた応答)を返すAPI トップページのカレンダーはこれで描画される
const CALENDAR_API_URL = `${DB_BASE_URL}/race/ajax_race_calendar.html`;

// 月のカレンダーを取得できないことが続いた場合に諦めるまでの月数 移植元は空の応答でここを無限ループしていた
const MAX_CONSECUTIVE_FAILED_MONTHS = 3;
// ページ1件の取得を試みる回数 日別一覧は混雑時に数秒かかり 既定のタイムアウトを超えることがある
const FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;
// 相手サーバーへの負荷を抑えるため 取得のたびに置く待機時間
const DEFAULT_REQUEST_DELAY_MS = 500;
// 開催日は日本時間で決まる
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** レースID群から結果ページのパス一覧を作る */
export function raceUrlPathsFromIds(raceIds: readonly string[]): string[] {
    return raceIds.map((raceId) => `/race/${raceId}/`);
}

/**
 * 保存済みのレース結果パス一覧を読み込む
 *
 * @param filePath - 一覧ファイル
 * @param logger - ロガー
 * @returns 昇順に並べたパス一覧 ファイルが無い場合は空
 */
export async function importRaceUrlList(filePath: string, logger: Logger): Promise<string[]> {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
        logger.error(`file not found: ${filePath}`);
        return [];
    }
    const lines = (await file.text()).split("\n").map((line) => line.trim());
    return lines.filter((line) => line !== "").sort();
}

/**
 * レース結果パス一覧をファイルへ保存する
 *
 * 途中で中断しても既存ファイルを壊さないよう 一時ファイルへ書いてから置き換える
 *
 * @param filePath - 保存先
 * @param paths - パス一覧
 */
export async function exportRaceUrlList(filePath: string, paths: readonly string[]): Promise<void> {
    const sorted = [...paths].sort();
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    await Bun.write(temporaryPath, sorted.map((racePath) => `${racePath}\n`).join(""));
    await rename(temporaryPath, filePath);
}

/** レース一覧の作成に必要な外部とのやり取り */
export type RaceListDependencies = {
    logger: Logger;
    // URLを取得して本文を返す 失敗時は例外
    fetchHtml: (url: string) => Promise<string>;
    sleep?: (milliseconds: number) => Promise<void>;
    // 起点にする時刻 省略時は現在 テストで差し替える
    now?: Date;
    // 取得のたびに置く待機時間(ミリ秒)
    requestDelayMilliseconds?: number;
    // 日別一覧の取得結果を置くディレクトリ 指定すると 取得済みの日は通信せずここから読む 省略時は毎回取得する
    dayListCacheDirectory?: string;
};

/** 年と月(1から12)を表す */
export type YearMonth = { year: number; month: number };

function pad(value: number, width: number): string {
    return String(value).padStart(width, "0");
}

// 日本時間の今日の年月と YYYYMMDD を返す
function todayInJapan(now: Date): { yearMonth: YearMonth; yyyymmdd: string } {
    const shifted = new Date(now.getTime() + JST_OFFSET_MS);
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth() + 1;
    return { yearMonth: { year, month }, yyyymmdd: `${pad(year, 4)}${pad(month, 2)}${pad(shifted.getUTCDate(), 2)}` };
}

function dayListCachePath(directory: string, date: string): string {
    return path.join(directory, `race_day.${date}.txt`);
}

/**
 * 保存済みの日別一覧からレース結果パスを読む
 *
 * @returns パス一覧 保存が無い 読めない 中身が空または形式違いの場合はnull(取得し直す)
 */
async function readDayListCache(directory: string, date: string): Promise<string[] | null> {
    const file = Bun.file(dayListCachePath(directory, date));
    try {
        if (!(await file.exists())) {
            return null;
        }
        const paths = (await file.text())
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => RACE_PATH_PATTERN.test(line));
        return paths.length > 0 ? paths : null;
    } catch {
        return null;
    }
}

function monthsBefore({ year, month }: YearMonth, count: number): YearMonth {
    const index = year * 12 + (month - 1) - count;
    return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/**
 * hrefをdb.netkeiba.comのパスへ直す 絶対URLと相対パスのどちらも受ける
 *
 * @param href - リンク先
 * @param pattern - パスが従う形式
 * @returns 形式に合うパス 別のサイトや形式違いの場合はnull
 */
function toDatabasePath(href: string | undefined, pattern: RegExp): string | null {
    if (href == null) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(href, DB_BASE_URL);
    } catch {
        return null;
    }
    return url.origin === DB_BASE_URL && pattern.test(url.pathname) ? url.pathname : null;
}

/**
 * 月のカレンダーから 指定した月の開催日別一覧のパスを取り出す
 *
 * @param calendarHtml - カレンダーのHTML
 * @param month - 対象の月
 * @param lastDate - これより後の日(YYYYMMDD)は含めない
 * @returns 「/race/list/YYYYMMDD/」形式のパス 日付の昇順
 */
export function extractDayListPaths(calendarHtml: string, month: YearMonth, lastDate: string): string[] {
    const prefix = `${pad(month.year, 4)}${pad(month.month, 2)}`;
    const calendar = load(calendarHtml);
    const paths = new Set<string>();
    for (const anchor of calendar("div.race_calendar table td a").toArray()) {
        const listPath = toDatabasePath(calendar(anchor).attr("href"), RACE_LIST_PATH_PATTERN);
        const date = RACE_LIST_PATH_PATTERN.exec(listPath ?? "")?.[1];
        // 月の見出しにある前後の月へのリンクは table の外にあるため対象外 念のため月も確かめる
        if (listPath != null && date?.startsWith(prefix) && date <= lastDate) {
            paths.add(listPath);
        }
    }
    return [...paths].sort();
}

/**
 * 日別一覧から各レース結果ページのパスを取り出す
 *
 * @param listHtml - 日別一覧のHTML
 * @returns 「/race/<12桁のID>/」形式のパス 重複と対象外の場(ばんえい競馬)は除く
 */
export function extractRacePaths(listHtml: string): string[] {
    const list = load(listHtml);
    const paths = new Set<string>();
    for (const anchor of list("div#contents div#main div.race_list a[href]").toArray()) {
        const racePath = toDatabasePath(list(anchor).attr("href"), RACE_PATH_PATTERN);
        const raceId = RACE_PATH_PATTERN.exec(racePath ?? "")?.[1];
        if (racePath != null && raceId != null && !EXCLUDED_PLACE_CODES.has(raceId.slice(4, 6))) {
            paths.add(racePath);
        }
    }
    return [...paths];
}

/**
 * 直近の月から遡って レース結果ページのパス一覧を作る
 *
 * 今月から遡る月ごとに カレンダー → 開催日別のレース一覧 の順にたどり 各レースの結果ページのパスを集める
 * 月は計算で決める(サイトのトップページは月のリンクを返さなくなった) 今日より後の日は取得しない
 * 取得に失敗した日は読み飛ばし 最後にまとめて警告する 月のカレンダーが続けて取得できない場合は諦める
 *
 * 保存先(dayListCacheDirectory)を指定すると 取得できた日の一覧を日ごとに保存し 次回からは通信せずそれを使う
 * 結果がまだ増える今日と昨日は保存も再利用もしない 失敗した日と結果が空の日も保存しない(次回に取得し直す)
 *
 * @param periodInMonths - 遡る月数(今月を含む)
 * @param dependencies - 取得処理とロガー
 * @returns 収集したパス 重複は除く
 */
export async function makeRaceUrlList(periodInMonths: number, dependencies: RaceListDependencies): Promise<string[]> {
    const { logger, fetchHtml, dayListCacheDirectory } = dependencies;
    const wait = dependencies.sleep ?? sleep;
    const requestDelay = dependencies.requestDelayMilliseconds ?? DEFAULT_REQUEST_DELAY_MS;
    const now = dependencies.now ?? new Date();
    const today = todayInJapan(now);
    // 今日は結果が増え続け 昨日も地方競馬の夜の開催分が遅れて載るため 一昨日以前の日だけを確定した一覧として保存する
    const yesterday = todayInJapan(new Date(now.getTime() - DAY_MS)).yyyymmdd;
    let reusedDays = 0;
    const collected = new Set<string>();
    // 取得できず一覧から抜けた日 一覧が不完全なことに気づけるよう最後に報告する
    const skippedDays: string[] = [];

    // 失敗や空の応答は間を置いて試し直す 取得できなければnull
    const fetchWithRetry = async (url: string): Promise<string | null> => {
        for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
            try {
                const body = await fetchHtml(url);
                if (body !== "") {
                    await wait(requestDelay);
                    return body;
                }
                logger.warning(`html is empty: ${url}`);
            } catch (error) {
                logger.warning(`fetch failed: ${url}: ${describeError(error)}`);
            }
            if (attempt < FETCH_ATTEMPTS - 1) {
                await wait(RETRY_DELAY_MS);
            }
        }
        return null;
    };

    const reportSkippedDays = (): void => {
        if (skippedDays.length > 0) {
            logger.warning(`race list is incomplete, ${skippedDays.length} day(s) skipped: ${skippedDays.join(", ")}`);
        }
    };

    let failedMonths = 0;
    for (let offset = 0; offset < periodInMonths; offset++) {
        const month = monthsBefore(today.yearMonth, offset);
        const calendarUrl = `${CALENDAR_API_URL}?${new URLSearchParams({
            input: "UTF-8",
            output: "json",
            date: `${pad(month.year, 4)}${pad(month.month, 2)}01`,
        })}`;

        const calendarJson = await fetchWithRetry(calendarUrl);
        let calendarHtml: unknown;
        try {
            calendarHtml = calendarJson == null ? null : JSON.parse(calendarJson);
        } catch (error) {
            logger.warning(`calendar is not JSON: ${describeError(error)}`);
        }
        if (typeof calendarHtml !== "string") {
            failedMonths++;
            logger.error(`calendar not available: ${month.year}-${pad(month.month, 2)}`);
            if (failedMonths >= MAX_CONSECUTIVE_FAILED_MONTHS) {
                logger.error(`giving up after ${failedMonths} months without a calendar`);
                reportSkippedDays();
                return [...collected];
            }
            continue;
        }
        failedMonths = 0;

        for (const listPath of extractDayListPaths(calendarHtml, month, today.yyyymmdd)) {
            const date = RACE_LIST_PATH_PATTERN.exec(listPath)?.[1] ?? "";
            const cacheDirectory = date !== "" && date < yesterday ? dayListCacheDirectory : undefined;

            const cachedPaths = cacheDirectory == null ? null : await readDayListCache(cacheDirectory, date);
            if (cachedPaths != null) {
                logger.info(`race_list path: ${listPath} (already fetched)`);
                reusedDays++;
                for (const racePath of cachedPaths) {
                    collected.add(racePath);
                }
                continue;
            }

            logger.info(`race_list path: ${listPath}`);
            const listHtml = await fetchWithRetry(DB_BASE_URL + listPath);
            if (listHtml == null) {
                logger.warning(`skip race list: ${listPath}`);
                skippedDays.push(listPath);
                continue;
            }
            const dayPaths = extractRacePaths(listHtml);
            for (const racePath of dayPaths) {
                collected.add(racePath);
                logger.debug(`path: ${racePath}`);
            }
            // 保存に失敗しても一覧の作成は続ける 次回に取得し直すだけ
            if (cacheDirectory != null && dayPaths.length > 0) {
                try {
                    await exportRaceUrlList(dayListCachePath(cacheDirectory, date), dayPaths);
                } catch (error) {
                    logger.warning(`could not save race list of ${date}: ${describeError(error)}`);
                }
            }
        }
    }

    if (reusedDays > 0) {
        logger.info(`race list of ${reusedDays} day(s) was already fetched, no request was made`);
    }
    reportSkippedDays();
    return [...collected];
}
