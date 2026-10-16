//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

/** ログの重要度 */
export type LogLevel = "debug" | "info" | "warning" | "error";

/** アプリケーション全体で共有するロガー */
export type Logger = {
    debug(message: string): void;
    info(message: string): void;
    warning(message: string): void;
    // 例外を渡した場合はスタックトレースも出力する
    error(message: string, cause?: unknown): void;
};

const LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warning: 30,
    error: 40,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
    debug: "DEBUG",
    info: "INFO",
    warning: "WARNING",
    error: "ERROR",
};

function pad(value: number, width: number): string {
    return String(value).padStart(width, "0");
}

// 「2026-01-31 12:34:56,789」形式の時刻
function formatTimestamp(now: Date): string {
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}`;
    const time = `${pad(now.getHours(), 2)}:${pad(now.getMinutes(), 2)}:${pad(now.getSeconds(), 2)}`;
    return `${day} ${time},${pad(now.getMilliseconds(), 3)}`;
}

// 原因の連鎖をたどる深さの上限
const MAX_CAUSE_DEPTH = 5;

function describeSingleError(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }
    const text = error.stack ?? `${error.name}: ${error.message}`;
    // PostgreSQLのエラーコード(例: 40P01=デッドロック)などを持つ場合は併記する
    const code = "code" in error && typeof error.code === "string" ? ` [code=${error.code}]` : "";
    return `${text}${code}`;
}

/**
 * 例外から出力用の文字列を作る
 *
 * ORMが包んだ元の例外(cause)も「Caused by:」として連ねる
 *
 * @param error - catchで受け取った値
 * @returns スタックトレースがあればそれを 無ければ文字列化した値
 */
export function describeError(error: unknown): string {
    const lines: string[] = [];
    let current: unknown = error;
    for (let depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth++) {
        lines.push(depth === 0 ? describeSingleError(current) : `Caused by: ${describeSingleError(current)}`);
        current = current instanceof Error ? current.cause : undefined;
    }
    return lines.join("\n");
}

/**
 * 標準エラー出力へ書き出すロガーを作る
 *
 * @param minimumLevel - 出力する最小の重要度
 * @returns ロガー
 */
export function createLogger(minimumLevel: LogLevel): Logger {
    const write = (level: LogLevel, message: string): void => {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[minimumLevel]) {
            return;
        }
        process.stderr.write(`[${formatTimestamp(new Date())}][${LEVEL_LABEL[level]}] ${message}\n`);
    };

    return {
        debug: (message) => write("debug", message),
        info: (message) => write("info", message),
        warning: (message) => write("warning", message),
        error: (message, cause) =>
            write("error", cause === undefined ? message : `${message}\n${describeError(cause)}`),
    };
}
