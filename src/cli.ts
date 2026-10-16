//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { CliArguments } from "./cli-args.ts";
import { CliUsageError, parseCliArguments, USAGE } from "./cli-args.ts";
import { loadDatabaseConfig, readIntegerEnv, readNumberEnv } from "./config.ts";
import { createDatabase, runMigrations } from "./db/client.ts";
import { SkylarkCrud } from "./db/crud.ts";
import { buildFeatures, defaultFeatureConcurrency } from "./feature.ts";
import { createLogger, type Logger } from "./logger.ts";
import { downloadRaces, login } from "./scraper/downloader.ts";
import { fetchEucJpHtml, HttpStatusError, readResponseText, requestWithTimeout } from "./scraper/http.ts";
import { exportRaceUrlList, importRaceUrlList, makeRaceUrlList, raceUrlPathsFromIds } from "./scraper/race-list.ts";

// エラー応答の本文を一覧として読まないよう 2xx以外は例外にする
async function fetchPageText(url: string, timeoutSeconds: number): Promise<string> {
    const response = await requestWithTimeout(url, timeoutSeconds);
    if (!response.ok) {
        throw new HttpStatusError(response.status, url);
    }
    return readResponseText(response);
}

async function run(args: CliArguments, logger: Logger): Promise<void> {
    const env = process.env;
    const timeoutSeconds = readNumberEnv(env, "HTTP_TIMEOUT", 5);
    const maxConcurrentRequests = readIntegerEnv(env, "MAX_CONCURRENT_REQUESTS", 16);

    // tempディレクトリ作成
    const tempDir = path.normalize(args.temp);
    await mkdir(tempDir, { recursive: true });

    const db = createDatabase(loadDatabaseConfig(env));
    const crud = new SkylarkCrud(db, logger);

    try {
        await runMigrations(db);

        if (args.isRebuildAllTables) {
            await crud.truncateAllTables();
        }
        if (args.isRebuildFeature) {
            await crud.truncateTable("feature_tbl");
        }

        const raceListPath = path.join(tempDir, args.raceListFile);

        if (args.isUpdateRaceList) {
            logger.info("make race URL list");
            const paths = await makeRaceUrlList(args.periodOfMonths, {
                logger,
                fetchHtml: (url) => fetchPageText(url, timeoutSeconds),
            });
            await exportRaceUrlList(raceListPath, paths);
        }

        if (args.isScraping) {
            const racePaths =
                args.raceIds.length > 0
                    ? raceUrlPathsFromIds(args.raceIds)
                    : await importRaceUrlList(raceListPath, logger);

            if (racePaths.length > 0) {
                const credentials = {
                    loginId: env.NETKEIABA_LOGINID ?? "",
                    password: env.NETKEIABA_PASSWORD ?? "",
                };
                logger.info(`login: ${await login(credentials, timeoutSeconds, logger)}`);

                logger.info("Start download race data");
                await downloadRaces(racePaths, {
                    tempDir,
                    sink: crud,
                    logger,
                    maxConcurrentRequests,
                    timeoutSeconds,
                    fetchHtml: fetchEucJpHtml,
                });
                logger.info("End download race data");
            }
        }

        if (args.isFeature || args.isRebuildFeature) {
            await buildFeatures(crud, { concurrency: defaultFeatureConcurrency(), logger });
        }
    } finally {
        await db.$client.close();
    }
}

/**
 * コマンドラインのエントリーポイント
 *
 * 失敗はログへ記録し 終了コードで通知する
 *
 * @param argv - 実行ファイル名を除いた引数
 * @returns 終了コード 0=正常 1=処理失敗 2=引数不正
 */
export async function main(argv: readonly string[]): Promise<number> {
    let args: CliArguments;
    try {
        args = parseCliArguments(argv);
    } catch (error) {
        if (error instanceof CliUsageError) {
            process.stderr.write(`${USAGE}\ncli.ts: error: ${error.message}\n`);
            return 2;
        }
        throw error;
    }

    if (args.isHelp) {
        process.stdout.write(USAGE);
        return 0;
    }

    const logger = createLogger(args.isDebug ? "debug" : "info");
    try {
        await run(args, logger);
        return 0;
    } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error), error);
        return 1;
    }
}

if (import.meta.main) {
    process.exitCode = await main(Bun.argv.slice(2));
}
