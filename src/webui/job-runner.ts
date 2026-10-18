//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

// 画面から始めた処理(ジョブ)をサーバーの中で1件ずつ実行し ログと報告を上限付きで覚えておく
// ジョブはメモリにだけ保持する サーバーを再起動すると消える

import { createLoggerWithSink, describeError, type Logger } from "../logger.ts";

const DEFAULT_MAX_JOBS = 20;
const DEFAULT_MAX_LOG_LINES = 2000;
const DEFAULT_MAX_LINE_CHARS = 8000;
const DEFAULT_MAX_OUTPUT_CHARS = 200_000;
const TRUNCATED_MARK = "…(以下省略)";

/** ジョブの状態 */
export type JobStatus = "running" | "succeeded" | "failed";

/** ジョブの出力の種類 log=ログ output=処理結果の報告(コマンドラインの標準出力に当たる) */
export type JobEntryKind = "log" | "output";

/** ジョブの出力の1件 seq は生成順の通し番号 */
export type JobEntry = { seq: number; kind: JobEntryKind; text: string };

/** 画面に渡すジョブの内容 JSONにできる値だけを持つ */
export type JobView = {
    id: string;
    title: string;
    // 同じ内容をコマンドラインで実行する場合の引数
    commandLine: string;
    status: JobStatus;
    // 「YYYY-MM-DD HH:MM:SS」(サーバーのローカル時間)
    startedAt: string;
    finishedAt: string | null;
    entries: JobEntry[];
    // 上限を超えたため捨てた古いログの行数
    droppedLogLines: number;
    // 報告が上限を超えたため途中までになっているか
    isOutputTruncated: boolean;
    // entries の最後の seq 無い場合は取得時に指定した after (次の取得で after に渡す)
    lastSeq: number;
};

/** ジョブの一覧に出す内容 */
export type JobSummary = Pick<JobView, "id" | "title" | "commandLine" | "status" | "startedAt" | "finishedAt">;

/** ジョブの処理へ渡す出力先 */
export type JobContext = {
    logger: Logger;
    // 処理結果の報告の書き出し先
    output: (text: string) => void;
};

/** 開始するジョブ */
export type JobSpec = {
    title: string;
    commandLine: string;
    isDebug: boolean;
    // 失敗は例外で伝える(ログへ記録され ジョブは失敗になる)
    execute: (context: JobContext) => Promise<void>;
};

/** ジョブを始められなかった理由 busy=実行中のジョブがある stopping=サーバーを止める途中 */
export type StartJobResult =
    | { ok: true; id: string }
    | { ok: false; reason: "busy"; runningJobId: string }
    | { ok: false; reason: "stopping" };

/** ジョブランナーの設定 */
export type JobRunnerOptions = {
    // 各ジョブのログの写しを残す先(サーバーのログ)
    logger: Logger;
    maxJobs?: number;
    maxLogLines?: number;
    maxLineChars?: number;
    maxOutputChars?: number;
    now?: () => Date;
};

/** ジョブを1件ずつ実行する */
export type JobRunner = {
    start(spec: JobSpec): StartJobResult;
    // after より後に出力された分だけを含める 無いジョブはundefined
    view(id: string, after?: number): JobView | undefined;
    // 新しい順
    list(): JobSummary[];
    // 実行中のジョブのIDがあれば返す
    runningJobId(): string | null;
    // 以降のジョブの開始を断る
    stopAccepting(): void;
    // 実行中のジョブが終わるまで待つ
    whenIdle(): Promise<void>;
};

type JobRecord = {
    id: string;
    title: string;
    commandLine: string;
    status: JobStatus;
    startedAt: Date;
    finishedAt: Date | null;
    entries: JobEntry[];
    nextSeq: number;
    logLines: number;
    droppedLogLines: number;
    outputChars: number;
    isOutputTruncated: boolean;
};

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

/**
 * 日時を「YYYY-MM-DD HH:MM:SS」(ローカル時間)の文字列にする
 *
 * @param date - 日時
 * @returns 文字列
 */
export function formatLocalDateTime(date: Date): string {
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function truncateText(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit)}${TRUNCATED_MARK}`;
}

/**
 * ジョブランナーを作る
 *
 * 同時に実行するジョブは1件だけ(テーブルの削除や特徴量の計算が互いに干渉しないようにするため)
 *
 * @param options - 保持する量の上限など
 * @returns ジョブランナー
 */
export function createJobRunner(options: JobRunnerOptions): JobRunner {
    const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
    const maxLogLines = options.maxLogLines ?? DEFAULT_MAX_LOG_LINES;
    const maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
    const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    const now = options.now ?? (() => new Date());

    // 開始順
    const jobs: JobRecord[] = [];
    let running: { record: JobRecord; task: Promise<void> } | null = null;
    let isStopping = false;

    const appendLog = (record: JobRecord, text: string): void => {
        record.entries.push({ seq: record.nextSeq++, kind: "log", text: truncateText(text, maxLineChars) });
        record.logLines++;
        if (record.logLines > maxLogLines) {
            // 報告は消さず 最も古いログから捨てる
            const index = record.entries.findIndex((entry) => entry.kind === "log");
            if (index >= 0) {
                record.entries.splice(index, 1);
                record.logLines--;
                record.droppedLogLines++;
            }
        }
    };

    const appendOutput = (record: JobRecord, text: string): void => {
        const remaining = maxOutputChars - record.outputChars;
        if (remaining <= 0) {
            record.isOutputTruncated = true;
            return;
        }
        const chunk = text.length > remaining ? text.slice(0, remaining) : text;
        if (chunk.length < text.length) {
            record.isOutputTruncated = true;
        }
        record.outputChars += chunk.length;
        record.entries.push({ seq: record.nextSeq++, kind: "output", text: chunk });
    };

    // ジョブのログは 画面用に覚えると同時に サーバーのログにも写す
    const createJobLogger = (record: JobRecord, isDebug: boolean): Logger => {
        const sink = createLoggerWithSink(isDebug ? "debug" : "info", (line) => appendLog(record, line));
        return {
            debug: (message) => {
                sink.debug(message);
                options.logger.debug(message);
            },
            info: (message) => {
                sink.info(message);
                options.logger.info(message);
            },
            warning: (message) => {
                sink.warning(message);
                options.logger.warning(message);
            },
            error: (message, cause) => {
                sink.error(message, cause);
                options.logger.error(message, cause);
            },
        };
    };

    const toSummary = (record: JobRecord): JobSummary => ({
        id: record.id,
        title: record.title,
        commandLine: record.commandLine,
        status: record.status,
        startedAt: formatLocalDateTime(record.startedAt),
        finishedAt: record.finishedAt == null ? null : formatLocalDateTime(record.finishedAt),
    });

    // 保持数の上限に収まるよう 終わったジョブを古い順に捨てる
    const makeRoomForNewJob = (): void => {
        while (jobs.length >= maxJobs) {
            const index = jobs.findIndex((job) => job.status !== "running");
            if (index < 0) {
                return;
            }
            jobs.splice(index, 1);
        }
    };

    return {
        start(spec) {
            if (isStopping) {
                return { ok: false, reason: "stopping" };
            }
            if (running != null) {
                return { ok: false, reason: "busy", runningJobId: running.record.id };
            }

            makeRoomForNewJob();
            const record: JobRecord = {
                id: crypto.randomUUID(),
                title: spec.title,
                commandLine: spec.commandLine,
                status: "running",
                startedAt: now(),
                finishedAt: null,
                entries: [],
                nextSeq: 0,
                logLines: 0,
                droppedLogLines: 0,
                outputChars: 0,
                isOutputTruncated: false,
            };
            jobs.push(record);

            const logger = createJobLogger(record, spec.isDebug);
            // execute が同期的に失敗しても 先に実行中として登録してから終了処理が走るようにする
            const current: { record: JobRecord; task: Promise<void> } = { record, task: Promise.resolve() };
            running = current;
            current.task = (async (): Promise<void> => {
                try {
                    await spec.execute({ logger, output: (text) => appendOutput(record, text) });
                    record.status = "succeeded";
                } catch (error) {
                    // コマンドラインと同じく 失敗はログへ記録して終わる
                    logger.error(error instanceof Error ? error.message : describeError(error), error);
                    record.status = "failed";
                } finally {
                    record.finishedAt = now();
                    if (running === current) {
                        running = null;
                    }
                }
            })();
            return { ok: true, id: record.id };
        },

        view(id, after = -1) {
            const record = jobs.find((job) => job.id === id);
            if (record == null) {
                return undefined;
            }
            const entries = record.entries.filter((entry) => entry.seq > after);
            return {
                ...toSummary(record),
                entries,
                droppedLogLines: record.droppedLogLines,
                isOutputTruncated: record.isOutputTruncated,
                lastSeq: entries.at(-1)?.seq ?? after,
            };
        },

        list() {
            return jobs.map(toSummary).reverse();
        },

        runningJobId() {
            return running?.record.id ?? null;
        },

        stopAccepting() {
            isStopping = true;
        },

        async whenIdle() {
            await running?.task;
        },
    };
}
