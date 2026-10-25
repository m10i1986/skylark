//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { resolve } from "node:path";

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { type CliArguments, DEFAULT_TEMP_DIRECTORY } from "../cli-args.ts";
import { loadDatabaseConfig, readIntegerEnv } from "../config.ts";
import { createDatabase, runMigrations } from "../db/client.ts";
import { SkylarkCrud } from "../db/crud.ts";
import type { RaceInfoRecord } from "../db/schema.ts";
import { createLogger, describeError, type Logger } from "../logger.ts";
import { runOperations } from "../operations.ts";
import { circuitOfRaceId } from "../predict/history.ts";
import { renderDocument } from "./document.tsx";
import { createJobRunner, type JobRunner, type JobSpec } from "./job-runner.ts";
import {
    createNetkeibaClient,
    type NetkeibaClient,
    type RaceDate,
    type RaceInformation,
    type RaceListItem,
} from "./netkeiba-client.ts";
import type { OperationFormValues } from "./operation-fields.ts";
import { buildOperationDefaults, collectFormValues, parseOperationForm } from "./operation-form.ts";
import type { JobEventsResponse } from "./operations-views.tsx";
import { createTtlCache } from "./ttl-cache.ts";
import type { Notice, RaceDetail } from "./views.tsx";

// 取得結果を使い回す時間 元のStreamlit版がセッション中は再取得しなかったことに合わせる
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8501;

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const RACE_ID_PATTERN = /^\d{1,18}$/;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AFTER_PATTERN = /^\d{1,12}$/;
// 操作フォームの本文の上限 入力欄の上限(レースID)に余裕を足した値
const OPERATION_BODY_LIMIT_BYTES = 64 * 1024;

// 配信するクライアントのファイル 名前を固定し 任意のパスを読ませない(scripts/build-webui.tsが作る)
const ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
    "app.js": "text/javascript; charset=utf-8",
    "app.css": "text/css; charset=utf-8",
};
const DEFAULT_ASSETS_DIRECTORY = resolve(import.meta.dir, "../../dist/webui");

// 画面に出す通知は固定の種類だけをクエリで受け取る(任意の文字列を表示しない)
const NOTICES = {
    saved: { kind: "ok", text: "レース情報をDBへ保管しました。" },
    exists: { kind: "info", text: "このレースは既にDBへ保管されています。" },
    expired: { kind: "error", text: "表示から時間が経ったため保管できませんでした。画面を再表示してください。" },
    failed: { kind: "error", text: "DBへの保管に失敗しました。ログを確認してください。" },
} as const satisfies Record<string, Notice>;

type NoticeCode = keyof typeof NOTICES;

function isNoticeCode(value: string | undefined): value is NoticeCode {
    return value != null && Object.hasOwn(NOTICES, value);
}

/** 操作の画面(CLIの全操作)が使う外部とのやり取り */
export type OperationsDependencies = {
    runner: JobRunner;
    // 受け付けた引数から 実行する処理を作る
    createExecutor: (args: CliArguments) => JobSpec["execute"];
    // HTMLキャッシュの置き場 画面からは変えさせない
    tempDirectory: string;
};

/** 画面が使う外部とのやり取り */
export type WebUiDependencies = {
    client: NetkeibaClient;
    logger: Logger;
    // 保管済みか確認する
    isRaceSaved: (raceId: number) => Promise<boolean>;
    saveRaceInfo: (record: RaceInfoRecord) => Promise<void>;
    // 今日の日付(YYYY-MM-DD)
    today: () => string;
    // Hostヘッダーのホスト名を許可するか DNSリバインディング対策
    isHostAllowed: (hostname: string) => boolean;
    // 作成済みのクライアント(JSとCSS)を置いたディレクトリ 省略時は dist/webui
    assetsDirectory?: string;
    // 省略すると操作の画面は無効(404)
    operations?: OperationsDependencies;
};

// 「0」以上で件数未満の整数だけを受け付け それ以外は先頭を選ぶ
function parseIndex(value: string | undefined, length: number): number {
    if (value == null || !/^\d{1,6}$/.test(value)) {
        return 0;
    }
    const index = Number(value);
    return index < length ? index : 0;
}

function hostnameOf(hostHeader: string | undefined): string {
    if (hostHeader == null) {
        return "";
    }
    // [::1]:8501 のようなIPv6表記では最後のコロンの後ろだけがポート
    return hostHeader.startsWith("[")
        ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
        : (hostHeader.split(":")[0] ?? "");
}

/**
 * 予測(-P)の対象にならない理由を返す
 *
 * 予測は当日開催の中央競馬だけが対象で それ以外のレースIDは実行時に読み飛ばされる 実行する前に画面で知らせる
 *
 * @param raceId - レースID
 * @param kaisaiDate - 開催日(YYYY-MM-DD) 不明な場合はnull
 * @param today - 今日の日付(YYYY-MM-DD)
 * @returns 理由 予測できる場合はnull
 */
function findUnpredictableReason(raceId: number, kaisaiDate: string | null, today: string): string | null {
    if (kaisaiDate == null) {
        return "開催日が分からないため予測できません。";
    }
    if (kaisaiDate !== today) {
        return "予測できるのは当日開催のレースだけです。";
    }
    if (circuitOfRaceId(raceId) !== "jra") {
        return "予測できるのは中央競馬のレースだけです。";
    }
    return null;
}

function todayLocal(): string {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * 画面のアプリケーションを作る
 *
 * @param dependencies - 取得処理やDBなど外部とのやり取り
 * @returns Honoのアプリケーション
 */
export function createApp(dependencies: WebUiDependencies): Hono {
    const { client, logger } = dependencies;
    const datesCache = createTtlCache<string, RaceDate[]>(CACHE_TTL_MS, CACHE_MAX_ENTRIES);
    const listCache = createTtlCache<string, RaceListItem[]>(CACHE_TTL_MS, CACHE_MAX_ENTRIES);
    const informationCache = createTtlCache<number, RaceInformation>(CACHE_TTL_MS, CACHE_MAX_ENTRIES);
    // 表示したレースの保管用レコード 保管ボタンは識別子だけを受け取り 内容はここから引く
    const savableRecords = createTtlCache<number, RaceInfoRecord>(CACHE_TTL_MS, CACHE_MAX_ENTRIES);

    const app = new Hono();

    app.use(
        secureHeaders({
            contentSecurityPolicy: {
                defaultSrc: ["'none'"],
                // スクリプトとCSSは同じオリジンの/assets/だけ
                scriptSrc: ["'self'"],
                // ジョブの進み具合の取得(fetch)は同じオリジンだけ
                connectSrc: ["'self'"],
                // 'unsafe-inline'はRadixが出す style属性のため(従来の方針と同じ)
                styleSrc: ["'self'", "'unsafe-inline'"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"],
                baseUri: ["'none'"],
            },
        }),
    );

    app.use(async (c, next) => {
        if (!dependencies.isHostAllowed(hostnameOf(c.req.header("host")))) {
            return c.text("Forbidden: unexpected Host header", 403);
        }
        await next();
    });

    // フォームの送信元(Origin)が同じオリジンであることを確かめる
    app.use(csrf());

    const assetsDirectory = dependencies.assetsDirectory ?? DEFAULT_ASSETS_DIRECTORY;
    app.get("/assets/:name", async (c) => {
        const name = c.req.param("name");
        const contentType = Object.hasOwn(ASSET_CONTENT_TYPES, name) ? ASSET_CONTENT_TYPES[name] : undefined;
        if (contentType == null) {
            return c.notFound();
        }
        const file = Bun.file(resolve(assetsDirectory, name));
        if (!(await file.exists())) {
            logger.error(`web UI asset not found: ${name} (run "pnpm build:webui")`);
            return c.text("Not Found", 404);
        }
        // 作り直したファイルをすぐ使えるよう 毎回確認させる
        return new Response(file, { headers: { "content-type": contentType, "cache-control": "no-cache" } });
    });

    app.get("/", async (c) => {
        const noticeQuery = c.req.query("n");
        let notice: Notice | null = isNoticeCode(noticeQuery) ? NOTICES[noticeQuery] : null;
        let dates: RaceDate[] = [];

        try {
            dates = await datesCache.getOrLoad("dates", () => client.fetchRaceDates(dependencies.today()));
        } catch (error) {
            logger.error(`failed to fetch race dates: ${describeError(error)}`);
            notice = { kind: "error", text: "開催日を取得できませんでした。しばらくしてから再表示してください。" };
        }

        const dateIndex = parseIndex(c.req.query("date"), dates.length);
        const selectedDate = dates[dateIndex];
        let races: RaceListItem[] | null = null;
        let detail: RaceDetail | null = null;
        let raceIndex = 0;
        let selectedRaceText: string | null = null;

        if (selectedDate != null) {
            try {
                races = await listCache.getOrLoad(selectedDate.href, () => client.fetchRaceList(selectedDate.href));
            } catch (error) {
                logger.error(`failed to fetch race list: ${describeError(error)}`);
                notice = { kind: "error", text: "レース一覧を取得できませんでした。" };
            }
        }

        if (races != null) {
            raceIndex = parseIndex(c.req.query("race"), races.length);
        }
        const selectedRace = races?.[raceIndex];
        if (selectedDate != null && selectedRace?.raceId != null) {
            const raceId = selectedRace.raceId;
            selectedRaceText = selectedRace.text;
            try {
                const information = await informationCache.getOrLoad(raceId, () => client.fetchRaceInformation(raceId));
                detail = await buildDetail(raceId, information, selectedDate, selectedRace);
            } catch (error) {
                logger.error(`failed to fetch race information: ${describeError(error)}`);
                notice = { kind: "error", text: "レース情報を取得できませんでした。" };
            }
        }

        return c.html(
            renderDocument({
                page: "index",
                dates,
                dateIndex,
                races,
                raceIndex,
                selectedRaceText,
                detail,
                notice,
                isOperationsEnabled: dependencies.operations != null,
            }),
        );
    });

    // 表示用の詳細を作り 保管できる場合は保管用のレコードを覚えておく
    async function buildDetail(
        raceId: number,
        information: RaceInformation,
        selectedDate: RaceDate,
        selectedRace: RaceListItem,
    ): Promise<RaceDetail> {
        const { race, horses } = information;
        let unsavableReason: string | null = null;
        if (selectedDate.kaisaiDate == null) {
            unsavableReason = "開催日が分からないため保管できません。";
        } else if (race.raceName == null || race.raceNumber == null) {
            unsavableReason = "レース名またはレース番号が取得できないため保管できません。";
        } else {
            savableRecords.set(raceId, {
                ...race,
                raceName: race.raceName,
                raceNumber: race.raceNumber,
                date: selectedDate.kaisaiDate,
                placeDetail: selectedRace.courseName,
            });
        }

        let isSaved = false;
        try {
            isSaved = await dependencies.isRaceSaved(raceId);
        } catch (error) {
            // DBへ接続できなくても表示は続ける
            logger.error(`failed to check saved state: ${describeError(error)}`);
        }

        return {
            raceId,
            race,
            horses,
            kaisaiDate: selectedDate.kaisaiDate,
            isSaved,
            unsavableReason,
            unpredictableReason: findUnpredictableReason(raceId, selectedDate.kaisaiDate, dependencies.today()),
        };
    }

    app.post("/save", async (c) => {
        const form = await c.req.parseBody();
        const rawRaceId = typeof form.raceId === "string" ? form.raceId : "";
        const dateIndex = parseIndex(typeof form.date === "string" ? form.date : undefined, Number.MAX_SAFE_INTEGER);
        const raceIndex = parseIndex(typeof form.race === "string" ? form.race : undefined, Number.MAX_SAFE_INTEGER);
        const back = (code: NoticeCode): Response => c.redirect(`/?date=${dateIndex}&race=${raceIndex}&n=${code}`, 303);

        if (!RACE_ID_PATTERN.test(rawRaceId)) {
            return c.text("Bad Request", 400);
        }
        const raceId = Number(rawRaceId);
        const record = savableRecords.get(raceId);
        if (record == null) {
            return back("expired");
        }

        try {
            if (await dependencies.isRaceSaved(raceId)) {
                return back("exists");
            }
            await dependencies.saveRaceInfo(record);
            return back("saved");
        } catch (error) {
            logger.error(`failed to save race info: ${describeError(error)}`);
            return back("failed");
        }
    });

    registerOperationRoutes(app, dependencies);

    return app;
}

// 操作の画面 CLIの全操作を画面から実行し 進み具合を見る
function registerOperationRoutes(app: Hono, dependencies: WebUiDependencies): void {
    const { operations } = dependencies;
    if (operations == null) {
        return;
    }
    const defaults = buildOperationDefaults(operations.tempDirectory);

    const renderOperations = (values: OperationFormValues, errors: string[], notice: Notice | null): string =>
        renderDocument({
            page: "operations",
            values,
            errors,
            notice,
            defaults,
            jobs: operations.runner.list(),
            runningJobId: operations.runner.runningJobId(),
        });

    app.get("/operations", (c) => c.html(renderOperations({}, [], null)));

    app.post(
        "/operations",
        bodyLimit({ maxSize: OPERATION_BODY_LIMIT_BYTES, onError: (c) => c.text("Payload Too Large", 413) }),
        async (c) => {
            const values = collectFormValues(await c.req.parseBody());
            const parsed = parseOperationForm(values);
            if (!parsed.ok) {
                return c.html(renderOperations(values, parsed.errors, null), 400);
            }

            // HTMLキャッシュの置き場は画面から指定させない
            const args: CliArguments = { ...parsed.operation.args, temp: operations.tempDirectory };
            const started = operations.runner.start({
                title: parsed.operation.title,
                commandLine: parsed.operation.commandLine,
                isDebug: args.isDebug,
                execute: operations.createExecutor(args),
            });
            if (started.ok) {
                return c.redirect(`/jobs/${started.id}`, 303);
            }
            const text =
                started.reason === "busy"
                    ? "別のジョブが実行中のため、始められませんでした。終わってからもう一度実行してください。"
                    : "サーバーを停止する途中のため、ジョブを始められません。";
            const status: ContentfulStatusCode = started.reason === "busy" ? 409 : 503;
            return c.html(renderOperations(values, [], { kind: "error", text }), status);
        },
    );

    app.get("/jobs/:id", (c) => {
        const id = c.req.param("id");
        const job = JOB_ID_PATTERN.test(id) ? operations.runner.view(id) : undefined;
        if (job == null) {
            return c.text("Not Found", 404);
        }
        return c.html(renderDocument({ page: "job", job }));
    });

    // 画面が一定間隔で呼ぶ after より後の出力と 現在の状態を返す
    app.get("/jobs/:id/events", (c) => {
        const id = c.req.param("id");
        const afterText = c.req.query("after");
        const after = afterText != null && AFTER_PATTERN.test(afterText) ? Number(afterText) : -1;
        const job = JOB_ID_PATTERN.test(id) ? operations.runner.view(id, after) : undefined;
        if (job == null) {
            return c.json({ error: "not found" }, 404);
        }
        const body: JobEventsResponse = {
            status: job.status,
            finishedAt: job.finishedAt,
            entries: job.entries,
            droppedLogLines: job.droppedLogLines,
            isOutputTruncated: job.isOutputTruncated,
            lastSeq: job.lastSeq,
        };
        c.header("cache-control", "no-store");
        return c.json(body);
    });
}

/** サーバー起動の設定 */
export type WebUiServerOptions = {
    hostname: string;
    port: number;
    chromiumExecutablePath?: string;
    // ループバック以外で待ち受けるときも 操作の画面を有効にするか(認証が無いため 明示した場合だけ)
    isOperationsAllowedOnNetwork?: boolean;
    // HTMLキャッシュの置き場 省略時は ./temp
    tempDirectory?: string;
};

/** 起動したサーバーの操作 */
export type WebUiServer = {
    port: number;
    // 実行中のジョブがあるか
    hasRunningJob: () => boolean;
    // 新しいジョブを断り 実行中のジョブが終わるのを待ってから止める
    stop: () => Promise<void>;
};

/**
 * 画面のサーバーを起動する
 *
 * DBへの接続は最初に必要になった時点で行う
 *
 * @param options - 待ち受けの設定
 * @param logger - ロガー
 * @returns 停止用の関数など
 */
export function startWebUi(options: WebUiServerOptions, logger: Logger): WebUiServer {
    const client = createNetkeibaClient({ executablePath: options.chromiumExecutablePath });
    let database: ReturnType<typeof createDatabase> | null = null;
    let crudPromise: Promise<SkylarkCrud> | null = null;

    const getCrud = (): Promise<SkylarkCrud> => {
        crudPromise ??= (async () => {
            database = createDatabase(loadDatabaseConfig());
            await runMigrations(database);
            return new SkylarkCrud(database, logger);
        })();
        // 失敗した場合は次の機会に再試行できるよう 保持しない
        crudPromise.catch(() => {
            crudPromise = null;
        });
        return crudPromise;
    };

    const isLoopbackOnly = LOOPBACK_HOSTNAMES.has(options.hostname);
    const isOperationsEnabled = isLoopbackOnly || options.isOperationsAllowedOnNetwork === true;
    if (!isLoopbackOnly) {
        logger.warning(`listening on ${options.hostname}: this UI has no authentication and can write to the DB`);
        if (isOperationsEnabled) {
            logger.warning(
                "operations are enabled (WEBUI_ENABLE_OPERATIONS): anyone who can reach this port can delete data and start downloads",
            );
        } else {
            logger.info("operations are disabled on this host (set WEBUI_ENABLE_OPERATIONS=1 to enable them)");
        }
    }

    const tempDirectory = options.tempDirectory ?? DEFAULT_TEMP_DIRECTORY;
    const runner = isOperationsEnabled ? createJobRunner({ logger }) : null;

    const app = createApp({
        client,
        logger,
        today: todayLocal,
        isHostAllowed: (hostname) => !isLoopbackOnly || LOOPBACK_HOSTNAMES.has(hostname),
        isRaceSaved: async (raceId) => (await (await getCrud()).getRaceInfo(raceId)) != null,
        saveRaceInfo: async (record) => (await getCrud()).insertRaceInfo(record),
        operations:
            runner == null
                ? undefined
                : {
                      runner,
                      tempDirectory,
                      createExecutor: (args) => async (context) => {
                          await runOperations(args, {
                              logger: context.logger,
                              output: context.output,
                              env: process.env,
                              // 閲覧の画面と同じブラウザを使い回す ジョブが終わっても閉じない
                              acquireNetkeibaClient: async () => ({ client, release: async () => {} }),
                              // 進捗は標準エラー出力ではなく ジョブのログへ出す
                              writeProgressLine: (line) => context.logger.info(line),
                          });
                      },
                  },
    });

    const server = Bun.serve({ hostname: options.hostname, port: options.port, fetch: app.fetch });
    logger.info(
        `Skylark web UI: http://${options.hostname.includes(":") ? `[${options.hostname}]` : options.hostname}:${server.port}/`,
    );

    return {
        port: server.port ?? options.port,
        hasRunningJob: () => runner?.runningJobId() != null,
        stop: async () => {
            // 実行中のジョブが使うブラウザとDBを閉じてしまわないよう 先にジョブの終了を待つ
            runner?.stopAccepting();
            await runner?.whenIdle();
            await server.stop();
            await client.close();
            await database?.$client.close();
        },
    };
}

// 「1」か「true」のときだけ有効 それ以外(未設定を含む)は無効
function isEnabledFlag(value: string | undefined): boolean {
    return value === "1" || value?.toLowerCase() === "true";
}

if (import.meta.main) {
    const logger = createLogger("info");
    const chromiumExecutablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
    const { stop, hasRunningJob } = startWebUi(
        {
            hostname: process.env.WEBUI_HOST ?? DEFAULT_HOST,
            port: readIntegerEnv(process.env, "WEBUI_PORT", DEFAULT_PORT),
            // 空文字は未指定として扱う
            chromiumExecutablePath: chromiumExecutablePath === "" ? undefined : chromiumExecutablePath,
            isOperationsAllowedOnNetwork: isEnabledFlag(process.env.WEBUI_ENABLE_OPERATIONS),
        },
        logger,
    );
    let isStopping = false;
    const shutdown = (): void => {
        if (isStopping) {
            logger.warning("forced exit while a job is running");
            process.exit(1);
        }
        isStopping = true;
        if (hasRunningJob()) {
            logger.warning("waiting for the running job to finish (send the signal again to force exit)");
        }
        void stop().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
