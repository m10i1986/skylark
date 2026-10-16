//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";

import { loadDatabaseConfig, readIntegerEnv } from "../config.ts";
import { createDatabase, runMigrations } from "../db/client.ts";
import { SkylarkCrud } from "../db/crud.ts";
import type { RaceInfoRecord } from "../db/schema.ts";
import { createLogger, describeError, type Logger } from "../logger.ts";
import {
    createNetkeibaClient,
    type NetkeibaClient,
    type RaceDate,
    type RaceInformation,
    type RaceListItem,
} from "./netkeiba-client.ts";
import { createTtlCache } from "./ttl-cache.ts";
import { IndexPage, type Notice, type RaceDetail } from "./views.tsx";

// 取得結果を使い回す時間 元のStreamlit版がセッション中は再取得しなかったことに合わせる
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8501;

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const RACE_ID_PATTERN = /^\d{1,18}$/;

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
                styleSrc: ["'unsafe-inline'"],
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
            <IndexPage
                dates={dates}
                dateIndex={dateIndex}
                races={races}
                raceIndex={raceIndex}
                selectedRaceText={selectedRaceText}
                detail={detail}
                notice={notice}
            />,
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

        return { raceId, race, horses, kaisaiDate: selectedDate.kaisaiDate, isSaved, unsavableReason };
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

    return app;
}

/** サーバー起動の設定 */
export type WebUiServerOptions = {
    hostname: string;
    port: number;
    chromiumExecutablePath?: string;
};

/**
 * 画面のサーバーを起動する
 *
 * DBへの接続は最初に必要になった時点で行う
 *
 * @param options - 待ち受けの設定
 * @param logger - ロガー
 * @returns 停止用の関数
 */
export function startWebUi(options: WebUiServerOptions, logger: Logger): { port: number; stop: () => Promise<void> } {
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
    if (!isLoopbackOnly) {
        logger.warning(`listening on ${options.hostname}: this UI has no authentication and can write to the DB`);
    }

    const app = createApp({
        client,
        logger,
        today: todayLocal,
        isHostAllowed: (hostname) => !isLoopbackOnly || LOOPBACK_HOSTNAMES.has(hostname),
        isRaceSaved: async (raceId) => (await (await getCrud()).getRaceInfo(raceId)) != null,
        saveRaceInfo: async (record) => (await getCrud()).insertRaceInfo(record),
    });

    const server = Bun.serve({ hostname: options.hostname, port: options.port, fetch: app.fetch });
    logger.info(
        `Skylark web UI: http://${options.hostname.includes(":") ? `[${options.hostname}]` : options.hostname}:${server.port}/`,
    );

    return {
        port: server.port ?? options.port,
        stop: async () => {
            await server.stop();
            await client.close();
            await database?.$client.close();
        },
    };
}

if (import.meta.main) {
    const logger = createLogger("info");
    const chromiumExecutablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
    const { stop } = startWebUi(
        {
            hostname: process.env.WEBUI_HOST ?? DEFAULT_HOST,
            port: readIntegerEnv(process.env, "WEBUI_PORT", DEFAULT_PORT),
            // 空文字は未指定として扱う
            chromiumExecutablePath: chromiumExecutablePath === "" ? undefined : chromiumExecutablePath,
        },
        logger,
    );
    const shutdown = (): void => {
        void stop().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
