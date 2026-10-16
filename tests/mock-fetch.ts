//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import type { Logger } from "../src/logger.ts";

/** fetch の呼び出し記録 */
export type FetchCall = { url: string; init: RequestInit | undefined };

/**
 * グローバルの fetch を差し替える ネットワークへは出ない
 *
 * @param handler - リクエストごとの応答
 * @returns 呼び出し記録と元に戻す関数
 */
export function mockFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
    const original = globalThis.fetch;
    const calls: FetchCall[] = [];
    // bun の fetch 型は preconnect を持つため 関数だけの代替は型が合わない テスト専用の差し替え
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push({ url, init });
        return handler(url, init);
    }) as unknown as typeof fetch;
    return {
        calls,
        restore: () => {
            globalThis.fetch = original;
        },
    };
}

/** 出力を記録するロガー */
export type RecordingLogger = Logger & {
    messages: { level: string; message: string }[];
    ofLevel(level: string): string[];
};

/**
 * 出力を配列へ記録するロガーを作る
 *
 * @returns ロガー
 */
export function createRecordingLogger(): RecordingLogger {
    const messages: { level: string; message: string }[] = [];
    const add = (level: string) => (message: string) => {
        messages.push({ level, message });
    };
    return {
        messages,
        ofLevel: (level) => messages.filter((entry) => entry.level === level).map((entry) => entry.message),
        debug: add("debug"),
        info: add("info"),
        warning: add("warning"),
        error: add("error"),
    };
}
