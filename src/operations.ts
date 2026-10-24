//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

// コマンドラインとWeb UIが共有する処理の本体
// どちらの入口も CliArguments を作って runOperations() を呼ぶ 出力先と外部とのやり取りだけが異なる

import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { CliArguments } from "./cli-args.ts";
import { loadDatabaseConfig, readIntegerEnv, readNumberEnv } from "./config.ts";
import { createDatabase, runMigrations } from "./db/client.ts";
import { type Database, SkylarkCrud } from "./db/crud.ts";
import { PredictionRepository } from "./db/prediction-repository.ts";
import { buildFeatures, defaultFeatureConcurrency } from "./feature.ts";
import type { Logger } from "./logger.ts";
import { formatLocalDate, predictToday } from "./predict/live.ts";
import { formatPredictions, formatTrainingReport, formatVerification } from "./predict/report.ts";
import { defaultTrainOptions, trainPredictionModel } from "./predict/train.ts";
import { downloadRaces, login } from "./scraper/downloader.ts";
import { fetchEucJpHtml, HttpStatusError, readResponseText, requestWithTimeout } from "./scraper/http.ts";
import { exportRaceUrlList, importRaceUrlList, makeRaceUrlList, raceUrlPathsFromIds } from "./scraper/race-list.ts";
import type { NetkeibaClient } from "./webui/netkeiba-client.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/** 開いたデータベース 終了時は close() を呼ぶ */
export type DatabaseHandle = {
    db: Database;
    // 未適用のマイグレーションを適用する
    migrate: () => Promise<void>;
    close: () => Promise<void>;
};

/** 借りた出馬表サイトの取得処理 使い終わったら release() を呼ぶ */
export type NetkeibaClientLease = {
    client: NetkeibaClient;
    release: () => Promise<void>;
};

/** 処理の外部とのやり取り */
export type OperationDependencies = {
    logger: Logger;
    // 処理結果の報告(コマンドラインでは標準出力)の書き出し先
    output: (text: string) => void;
    env: Environment;
    // 省略時は環境変数の設定でPostgreSQLへ接続する
    openDatabase?: (env: Environment) => DatabaseHandle;
    // 省略時は環境変数の設定でブラウザを起動する(-P のときだけ呼ぶ)
    acquireNetkeibaClient?: (env: Environment) => Promise<NetkeibaClientLease>;
    // 指定すると特徴量の進捗を標準エラー出力ではなくここへ1行ずつ渡す
    writeProgressLine?: (line: string) => void;
};

/**
 * 環境変数の設定でPostgreSQLへ接続する
 *
 * 接続は最初のクエリ発行時に確立される
 *
 * @param env - 環境変数
 * @returns 開いたデータベース
 */
export function openDatabaseFromEnvironment(env: Environment): DatabaseHandle {
    const db = createDatabase(loadDatabaseConfig(env));
    return {
        db,
        migrate: () => runMigrations(db),
        close: () => db.$client.close(),
    };
}

/**
 * 環境変数の設定でブラウザを起動する取得処理を作る
 *
 * Playwrightは重いため この時点で読み込む
 *
 * @param env - 環境変数
 * @returns 借りた取得処理
 */
export async function acquireNetkeibaClientFromEnvironment(env: Environment): Promise<NetkeibaClientLease> {
    const { createNetkeibaClient } = await import("./webui/netkeiba-client.ts");
    const chromiumExecutablePath = env.CHROMIUM_EXECUTABLE_PATH;
    const client = createNetkeibaClient({
        executablePath:
            chromiumExecutablePath == null || chromiumExecutablePath === "" ? undefined : chromiumExecutablePath,
    });
    return { client, release: () => client.close() };
}

// エラー応答の本文を一覧として読まないよう 2xx以外は例外にする
async function fetchPageText(url: string, timeoutSeconds: number): Promise<string> {
    const response = await requestWithTimeout(url, timeoutSeconds);
    if (!response.ok) {
        throw new HttpStatusError(response.status, url);
    }
    return readResponseText(response);
}

// 過去の結果から勝率モデルを学習し 評価を表示してDBへ保存する
async function trainAndSave(
    repository: PredictionRepository,
    args: CliArguments,
    dependencies: OperationDependencies,
): Promise<void> {
    const { logger } = dependencies;
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
            dev: result.dev,
            devBlocks: result.devBlocks,
            test: result.test,
            criteria: result.criteria,
        },
    });
    dependencies.output(formatTrainingReport(result, modelId));
    logger.info("End train");
}

// 当日開催の中央競馬を予測して表示する 出馬表はブラウザで取得するため 必要になった時点で借りる
async function predictAndPrint(
    repository: PredictionRepository,
    args: CliArguments,
    dependencies: OperationDependencies,
): Promise<void> {
    const { logger } = dependencies;
    const raceIds = args.raceIds.map((text) => {
        if (!/^\d{1,18}$/.test(text)) {
            throw new Error(`invalid race id: ${JSON.stringify(text)}`);
        }
        return Number(text);
    });
    const acquire = dependencies.acquireNetkeibaClient ?? acquireNetkeibaClientFromEnvironment;
    const lease = await acquire(dependencies.env);
    try {
        logger.info("Start predict");
        const result = await predictToday(
            { client: lease.client, repository, logger, now: () => new Date() },
            { criteria: args.valueCriteria, historySince: args.historySince, raceIds },
        );
        dependencies.output(formatPredictions(result, args.valueCriteria, args.isVerbose));
        logger.info("End predict");
    } finally {
        await lease.release();
    }
}

/**
 * 引数で指定された処理を順に実行する
 *
 * 実行順は テーブルの削除 → 一覧の更新(-U) → ダウンロード(-S) → 特徴量(-F) → 学習(-T) → 予測(-P) → 突き合わせ(--report)
 *
 * @param args - 実行する処理と設定
 * @param dependencies - ログと報告の書き出し先 DBとブラウザの取得方法
 * @throws 処理が失敗した場合(呼び出し元がログへ記録して失敗として扱う)
 */
export async function runOperations(args: CliArguments, dependencies: OperationDependencies): Promise<void> {
    const { logger, env } = dependencies;
    const timeoutSeconds = readNumberEnv(env, "HTTP_TIMEOUT", 5);
    const maxConcurrentRequests = readIntegerEnv(env, "MAX_CONCURRENT_REQUESTS", 16);

    // tempディレクトリ作成
    const tempDir = path.normalize(args.temp);
    await mkdir(tempDir, { recursive: true });

    const database = (dependencies.openDatabase ?? openDatabaseFromEnvironment)(env);
    const crud = new SkylarkCrud(database.db, logger);

    try {
        await database.migrate();

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
                dayListCacheDirectory: tempDir,
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
            await buildFeatures(crud, {
                concurrency: defaultFeatureConcurrency(),
                logger,
                writeProgressLine: dependencies.writeProgressLine,
            });
        }

        const predictionRepository = new PredictionRepository(database.db);

        if (args.isTrain) {
            await trainAndSave(predictionRepository, args, dependencies);
        }

        if (args.isPredict) {
            await predictAndPrint(predictionRepository, args, dependencies);
        }

        if (args.isReport) {
            const date = args.date ?? formatLocalDate(new Date());
            dependencies.output(formatVerification(date, await predictionRepository.listPredictionsWithResults(date)));
        }
    } finally {
        await database.close();
    }
}
