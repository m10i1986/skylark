//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { mkdir, rename } from "node:fs/promises";
import path from "node:path";

import { type CheerioAPI, load } from "cheerio";

import { sleep } from "../concurrency.ts";
import { describeError, type Logger } from "../logger.ts";

/** レース結果データベースのURL */
export const DB_BASE_URL = "https://db.netkeiba.com";

const RACE_PATH_PATTERN = /^\/race\/\d{12}\/$/;
const RACE_LIST_PATH_PATTERN = /^\/race\/list\/\d{8}\/$/;

// 空の応答が続いた場合に諦めるまでの回数 移植元はここで無限ループしていた
const MAX_CONSECUTIVE_EMPTY_RESPONSES = 3;
// 日別一覧の取得を試みる回数
const LIST_FETCH_ATTEMPTS = 2;
const LIST_RETRY_DELAY_MS = 3000;

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
};

/**
 * 直近の月から遡って レース結果ページのパス一覧を作る
 *
 * 月のトップページ → 日別のレース一覧 → 各レースの結果ページ の順にたどる
 * 移植元の仕様のとおり 次の月へのリンクは 最後に取得できたページ(日別一覧が取れなければ月のトップ)から探す
 *
 * @param periodInMonths - 遡る月数
 * @param dependencies - 取得処理とロガー
 * @returns 収集したパス(重複を含み得る)
 */
export async function makeRaceUrlList(periodInMonths: number, dependencies: RaceListDependencies): Promise<string[]> {
    const { logger, fetchHtml } = dependencies;
    const wait = dependencies.sleep ?? sleep;
    const collected: string[] = [];

    let url = `${DB_BASE_URL}/?pid=race_top`;
    let remainingMonths = periodInMonths;
    let emptyResponses = 0;

    while (remainingMonths > 0) {
        let html: string;
        try {
            html = await fetchHtml(url);
        } catch (error) {
            logger.error(describeError(error));
            return collected;
        }

        if (html === "") {
            logger.warning("html is empty");
            emptyResponses++;
            if (emptyResponses >= MAX_CONSECUTIVE_EMPTY_RESPONSES) {
                logger.error(`giving up after ${emptyResponses} empty responses: ${url}`);
                return collected;
            }
            continue;
        }
        emptyResponses = 0;

        const monthDocument = load(html);
        // 日別一覧が取得できなかった場合に直前のページを使い続ける挙動を再現するため 現在のページを持ち回る
        let currentDocument: CheerioAPI = monthDocument;

        for (const anchor of monthDocument("div#contents table tr td a[href^='/race/list/']").toArray()) {
            const listPath = monthDocument(anchor).attr("href");
            if (listPath == null || !RACE_LIST_PATH_PATTERN.test(listPath)) {
                continue;
            }
            logger.info(`race_list path: ${listPath}`);

            for (let attempt = 0; attempt < LIST_FETCH_ATTEMPTS; attempt++) {
                let listHtml: string;
                try {
                    listHtml = await fetchHtml(DB_BASE_URL + listPath);
                } catch (error) {
                    logger.warning(describeError(error));
                    continue;
                }

                if (listHtml === "") {
                    logger.warning("html is empty");
                    await wait(LIST_RETRY_DELAY_MS);
                    continue;
                }

                try {
                    currentDocument = load(listHtml);
                } catch (error) {
                    logger.error(describeError(error));
                }
                break;
            }

            // 日別一覧から各競馬場のレース結果ページのパスを取り出す
            for (const raceAnchor of currentDocument(
                "div#contents div#main div.race_list a[href^='/race/']",
            ).toArray()) {
                const racePath = currentDocument(raceAnchor).attr("href");
                if (racePath != null && RACE_PATH_PATTERN.test(racePath)) {
                    collected.push(racePath);
                    logger.debug(`path: ${racePath}, name: ${currentDocument(raceAnchor).text()}`);
                }
            }
        }

        // 前の月のページへ
        const previousMonthPath = currentDocument("div#contents div.race_calendar li a").eq(1).attr("href");
        if (previousMonthPath == null) {
            logger.warning("previous month link not found, stop");
            return collected;
        }
        url = `${DB_BASE_URL}${previousMonthPath}`;
        remainingMonths--;
    }

    return collected;
}
