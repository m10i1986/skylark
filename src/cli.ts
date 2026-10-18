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
import { PredictionRepository } from "./db/prediction-repository.ts";
import { buildFeatures, defaultFeatureConcurrency } from "./feature.ts";
import { createLogger, type Logger } from "./logger.ts";
import { formatLocalDate, predictToday } from "./predict/live.ts";
import { formatPredictions, formatTrainingReport, formatVerification } from "./predict/report.ts";
import { defaultTrainOptions, trainPredictionModel } from "./predict/train.ts";
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

// 過去の結果から勝率モデルを学習し 評価を表示してDBへ保存する
async function trainAndSave(repository: PredictionRepository, args: CliArguments, logger: Logger): Promise<void> {
    logger.info("Start train");
    const races = await repository.loadRaceRecords(args.historySince);
    const payouts = await repository.loadWinPayouts(args.historySince);
    logger.info(`loaded ${races.length} races since ${args.historySince}`);

    const options = defaultTrainOptions(args.valueCriteria);
    const result = trainPredictionModel(races, payouts, options);
    const modelId = await repository.insertModel({
        circuit: options.circuit,
        trainFrom: result.split.trainFrom,
        validFrom: result.split.validFrom,
        testFrom: result.split.testFrom,
        dataTo: result.split.dataTo,
        parameters: result.parameters,
        metrics: {
            selectedL2: result.selectedL2,
            l2Candidates: result.l2Candidates,
            races: result.races,
            valid: result.valid,
            test: result.test,
            criteria: result.criteria,
        },
    });
    process.stdout.write(formatTrainingReport(result, modelId));
    logger.info("End train");
}

// 当日開催の中央競馬を予測して表示する 出馬表は Playwright で取得するため この時点で読み込む
async function predictAndPrint(repository: PredictionRepository, args: CliArguments, logger: Logger): Promise<void> {
    const raceIds = args.raceIds.map((text) => {
        if (!/^\d{1,18}$/.test(text)) {
            throw new Error(`invalid race id: ${JSON.stringify(text)}`);
        }
        return Number(text);
    });
    const { createNetkeibaClient } = await import("./webui/netkeiba-client.ts");
    const chromiumExecutablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
    const client = createNetkeibaClient({
        executablePath:
            chromiumExecutablePath == null || chromiumExecutablePath === "" ? undefined : chromiumExecutablePath,
    });
    try {
        logger.info("Start predict");
        const result = await predictToday(
            { client, repository, logger, now: () => new Date() },
            { criteria: args.valueCriteria, historySince: args.historySince, raceIds },
        );
        process.stdout.write(formatPredictions(result, args.valueCriteria, args.isVerbose));
        logger.info("End predict");
    } finally {
        await client.close();
    }
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

        const predictionRepository = new PredictionRepository(db);

        if (args.isTrain) {
            await trainAndSave(predictionRepository, args, logger);
        }

        if (args.isPredict) {
            await predictAndPrint(predictionRepository, args, logger);
        }

        if (args.isReport) {
            const date = args.date ?? formatLocalDate(new Date());
            process.stdout.write(formatVerification(date, await predictionRepository.listPredictionsWithResults(date)));
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
