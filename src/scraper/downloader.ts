//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { rename } from "node:fs/promises";
import path from "node:path";

import { load } from "cheerio";

import { runWithConcurrency, sleep } from "../concurrency.ts";
import { describeError, type Logger } from "../logger.ts";
import { fetchEucJpHtml, HttpStatusError, readResponseText, requestWithTimeout } from "./http.ts";
import { DB_BASE_URL } from "./race-list.ts";
import { type RaceSink, scrapeRaceHtml } from "./race-scraper.ts";

/** netkeibaのログインURL */
const LOGIN_URL = "https://account.netkeiba.com";

// 取得しないレースID(ページ構造が特殊で解析できない)
const IGNORED_RACE_IDS: ReadonlySet<number> = new Set([200808020398, 200808020399, 202204010808, 202209040704]);

const RACE_PATH_PATTERN = /^\/race\/([0-9]+)\/$/;

/** ログインに使う資格情報 */
export type LoginCredentials = {
    loginId: string;
    password: string;
};

/**
 * netkeibaへログインを試みる
 *
 * 移植元の仕様のとおり Cookieは保持せず 後続のダウンロードには引き継がない 結果はログへ記録するためだけに使う
 *
 * @param credentials - 資格情報 未設定の場合はnull
 * @param timeoutSeconds - タイムアウト秒
 * @param logger - ロガー
 * @returns 成功はtrue 失敗はfalse 資格情報が無く試行しなかった場合はnull
 */
export async function login(
    credentials: LoginCredentials | null,
    timeoutSeconds: number,
    logger: Logger,
): Promise<boolean | null> {
    if (credentials == null || credentials.loginId === "" || credentials.password === "") {
        return null;
    }

    const form = new URLSearchParams({
        pid: "login",
        action: "auth",
        login_id: credentials.loginId,
        pswd: credentials.password,
    });
    const response = await requestWithTimeout(LOGIN_URL, timeoutSeconds, { method: "POST", body: form });
    const dom = load(await readResponseText(response));

    for (const element of dom("span.error").toArray()) {
        // ログイン失敗と思われる
        logger.error(dom(element).text());
        return false;
    }
    return true;
}

/** ダウンロードと解析の設定 */
export type DownloadOptions = {
    // HTMLの圧縮キャッシュを置くディレクトリ
    tempDir: string;
    sink: RaceSink;
    logger: Logger;
    maxConcurrentRequests: number;
    timeoutSeconds: number;
    // ダウンロード後や失敗後に置く待機時間(ミリ秒) 相手サーバーへの負荷を抑える
    politeDelayMilliseconds?: number;
    // HTML取得処理 テストで差し替える
    fetchHtml?: (url: string, timeoutSeconds: number) => Promise<string>;
};

function cachePathFor(tempDir: string, raceId: string): string {
    return path.join(tempDir, `race.${raceId}.html.zst`);
}

// 書きかけのファイルを残さないよう 一時ファイルへ書いてから置き換える
async function writeCache(filePath: string, html: string): Promise<void> {
    const compressed = await Bun.zstdCompress(new TextEncoder().encode(html));
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await Bun.write(temporaryPath, compressed);
    await rename(temporaryPath, filePath);
}

async function readCache(filePath: string): Promise<string> {
    const compressed = await Bun.file(filePath).bytes();
    return new TextDecoder("utf-8").decode(await Bun.zstdDecompress(compressed));
}

function formatIndex(index: number): string {
    return String(index).padStart(5, " ");
}

/**
 * レース結果ページを並行ダウンロードして解析結果を保存する
 *
 * キャッシュ(race.<id>.html.zst)がある場合は通信せずそれを使う 取得したHTMLはUTF-8へ変換してzstd圧縮し保存する
 * 1件の失敗は記録して他の処理を続ける
 *
 * @param racePaths - 「/race/<id>/」形式のパス一覧
 * @param options - ダウンロードと解析の設定
 */
export async function downloadRaces(racePaths: readonly string[], options: DownloadOptions): Promise<void> {
    const { logger, tempDir, sink } = options;
    const politeDelay = options.politeDelayMilliseconds ?? 1000;
    const fetchHtml = options.fetchHtml ?? fetchEucJpHtml;

    const tasks: Array<{ index: number; raceId: string; url: string }> = [];
    racePaths.forEach((racePath, index) => {
        const match = RACE_PATH_PATTERN.exec(racePath);
        if (match?.[1] != null) {
            tasks.push({ index, raceId: match[1], url: DB_BASE_URL + racePath });
        }
    });

    const processTask = async (task: (typeof tasks)[number]): Promise<void> => {
        const { index, raceId, url } = task;
        const numericRaceId = Number(raceId);
        const label = `[${formatIndex(index)}] race_id: ${numericRaceId}, url: ${url}`;

        if (IGNORED_RACE_IDS.has(numericRaceId)) {
            logger.warning(`${label}, reject[ignore_race_id]`);
            return;
        }
        logger.debug(`${label}, start`);

        const filePath = cachePathFor(tempDir, raceId);
        let html: string;

        if (!(await Bun.file(filePath).exists())) {
            try {
                html = await fetchHtml(url, options.timeoutSeconds);
            } catch (error) {
                logger.warning(error instanceof HttpStatusError ? error.message : describeError(error));
                await sleep(politeDelay);
                return;
            }
            logger.info(`${label}, download finish`);
            await writeCache(filePath, html);
            await sleep(politeDelay);
        } else {
            logger.info(`${label}, downloaded`);
            html = await readCache(filePath);
        }

        await scrapeRaceHtml(numericRaceId, html, sink, logger);
        logger.debug(`[${formatIndex(index)}] url: ${url}, done`);
    };

    await runWithConcurrency(tasks, options.maxConcurrentRequests, async (task) => {
        try {
            await processTask(task);
        } catch (error) {
            // キャッシュの破損やDB接続断など 1件の異常で全体を止めない
            logger.error(`race_id: ${task.raceId}, ${describeError(error)}`);
        }
    });
}
