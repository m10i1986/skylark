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
import { type BoxProposal, type BoxSelector, proposeBox, toBoxProposalRecord } from "./predict/ai-box.ts";
import { createBoxBaseRates, DEFAULT_BASE_RATE_SINCE } from "./predict/base-rates.ts";
import { buildHorseForm, type HorseForm } from "./predict/form.ts";
import { formatLocalDate, type PredictTodayResult, predictToday, type RacePrediction } from "./predict/live.ts";
import {
    formatBoxProposals,
    formatBoxVerification,
    formatPredictions,
    formatTrainingReport,
    formatVerification,
} from "./predict/report.ts";
import { defaultTrainOptions, trainPredictionModel } from "./predict/train.ts";
import { downloadRaces, login } from "./scraper/downloader.ts";
import { fetchEucJpHtml, HttpStatusError, readResponseText, requestWithTimeout } from "./scraper/http.ts";
import { exportRaceUrlList, importRaceUrlList, makeRaceUrlList, raceUrlPathsFromIds } from "./scraper/race-list.ts";
import type { NetkeibaClient, RaceInformation } from "./webui/netkeiba-client.ts";

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
    // 省略時は環境変数の設定でClaude CLIを呼ぶ(-B のときだけ呼ぶ)
    createBoxSelector?: (env: Environment) => Promise<BoxSelector> | BoxSelector;
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

/**
 * 環境変数の設定でClaude CLIを呼ぶ選定処理を作る
 *
 * -B のときだけ使うため この時点で読み込む
 *
 * @param env - 環境変数
 * @returns 3連単Boxの選定を依頼する処理
 */
export async function createBoxSelectorFromEnvironment(env: Environment): Promise<BoxSelector> {
    const { createClaudeCliBoxSelectorFromEnvironment } = await import("./predict/claude-cli-box.ts");
    return createClaudeCliBoxSelectorFromEnvironment(env);
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

// 当日開催の中央競馬を予測して保存する 出馬表はブラウザで取得するため 必要になった時点で借りる
async function predictRaces(
    repository: PredictionRepository,
    args: CliArguments,
    dependencies: OperationDependencies,
): Promise<PredictTodayResult> {
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
        logger.info("End predict");
        return result;
    } finally {
        await lease.release();
    }
}

// 出走馬ごとの過去走を 開催日より前の結果だけから読み込んでまとめる(馬番から引く)
async function loadHorseForms(
    repository: PredictionRepository,
    racePrediction: RacePrediction,
    information: RaceInformation,
): Promise<Map<number, HorseForm>> {
    const horseIds = racePrediction.runners.flatMap((runner) => (runner.horseId == null ? [] : [runner.horseId]));
    const runsByHorse = await repository.loadHorseRuns(horseIds, racePrediction.date);
    const target = {
        date: racePrediction.date,
        trackSurface: information.race.trackSurface ?? null,
        distance: information.race.distance ?? null,
    };
    return new Map(
        racePrediction.runners.map((runner) => [
            runner.horseNumber,
            buildHorseForm(runner.horseId == null ? [] : (runsByHorse.get(runner.horseId) ?? []), target),
        ]),
    );
}

// 予測したレースごとに 3連単Boxを提案させて保存し 報告する
// 認証や依頼の誤りなど どのレースでも失敗する場合は 提案できた分を報告してから失敗にする
async function proposeBoxesAndPrint(
    repository: PredictionRepository,
    prediction: PredictTodayResult,
    selector: BoxSelector,
    args: CliArguments,
    dependencies: OperationDependencies,
): Promise<void> {
    const { logger } = dependencies;
    logger.info("Start AI box");
    const proposals: BoxProposal[] = [];
    const skippedRaceIds = [...prediction.skippedRaceIds];
    const printReport = (): void => {
        dependencies.output(
            formatBoxProposals({
                date: prediction.date,
                proposals,
                skippedRaceIds,
                maxTickets: args.boxMaxTickets,
                fixedHorses: args.boxHorses,
            }),
        );
    };
    try {
        // 同じ条件の過去のレースの実績 開催日より前の結果だけを使う
        const baseRaces = await repository.loadRaceRecords(DEFAULT_BASE_RATE_SINCE, prediction.date);
        logger.info(`base rates: ${baseRaces.length} races since ${DEFAULT_BASE_RATE_SINCE}`);
        const baseRates = createBoxBaseRates(baseRaces);
        for (const racePrediction of prediction.predictions) {
            const information = prediction.informations.get(racePrediction.raceId);
            const proposal =
                information == null
                    ? null
                    : await proposeBox(
                          {
                              prediction: racePrediction,
                              information,
                              maxTickets: args.boxMaxTickets,
                              // 頭数を指定した場合は その頭数ちょうどのBoxだけを候補にする
                              ...(args.boxHorses == null ? {} : { minHorses: args.boxHorses }),
                              forms: await loadHorseForms(repository, racePrediction, information),
                              baseRates,
                          },
                          selector,
                          logger,
                      );
            if (proposal == null) {
                logger.warning(`race ${racePrediction.raceId}: no box can be made, skipped`);
                skippedRaceIds.push(racePrediction.raceId);
                continue;
            }
            await repository.insertBoxProposal(toBoxProposalRecord(proposal, prediction.modelId));
            proposals.push(proposal);
            logger.info(
                `race ${proposal.raceId}: box ${proposal.horseNumbers.join("-")} (${proposal.source}, ${proposal.ticketCount} tickets)`,
            );
        }
    } catch (error) {
        // 途中で失敗しても 保存した提案は報告する
        if (proposals.length > 0) {
            printReport();
        }
        throw error;
    }
    printReport();
    logger.info("End AI box");
}

/**
 * 引数で指定された処理を順に実行する
 *
 * 実行順は テーブルの削除 → 一覧の更新(-U) → ダウンロード(-S) → 特徴量(-F) → 学習(-T) → 予測(-P) → Boxの提案(-B) → 突き合わせ(--report)
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

        if (args.isPredict || args.isAiBox) {
            // 設定の誤りは 出馬表の取得より前に知らせる
            const selector = args.isAiBox
                ? await (dependencies.createBoxSelector ?? createBoxSelectorFromEnvironment)(env)
                : null;
            const result = await predictRaces(predictionRepository, args, dependencies);
            if (args.isPredict) {
                dependencies.output(formatPredictions(result, args.valueCriteria, args.isVerbose));
            }
            if (selector != null) {
                await proposeBoxesAndPrint(predictionRepository, result, selector, args, dependencies);
            }
        }

        if (args.isReport) {
            const date = args.date ?? formatLocalDate(new Date());
            dependencies.output(
                formatVerification(
                    date,
                    await predictionRepository.listPredictionsWithResults(date),
                    await predictionRepository.listRacesPredictedOnlyAfterPost(date),
                ),
            );
            // 提案が無い日は何も出さない
            const boxReport = formatBoxVerification(
                date,
                await predictionRepository.listBoxProposalsWithResults(date),
                await predictionRepository.listRacesProposedOnlyAfterPost(date),
            );
            if (boxReport !== "") {
                dependencies.output(boxReport);
            }
        }
    } finally {
        await database.close();
    }
}
