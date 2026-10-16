//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { TextDecoder as LabeledTextDecoder } from "node:util";

const USER_AGENT = "skylark/0.1.0";

/** HTTPの応答がエラー(2xx以外)だったことを表す */
export class HttpStatusError extends Error {
    readonly status: number;
    readonly url: string;

    constructor(status: number, url: string) {
        super(`HTTP ${status}: ${url}`);
        this.name = "HttpStatusError";
        this.status = status;
        this.url = url;
    }
}

/**
 * タイムアウト付きでHTTPリクエストを送る
 *
 * リダイレクトは追従しない(移植元のhttpxと同じ) 3xxは呼び出し元がそのまま受け取る
 *
 * @param url - リクエスト先
 * @param timeoutSeconds - リクエスト全体のタイムアウト秒
 * @param init - fetchの追加オプション
 * @returns 応答
 */
export async function requestWithTimeout(
    url: string,
    timeoutSeconds: number,
    init: RequestInit = {},
): Promise<Response> {
    return fetch(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
        headers: { "User-Agent": USER_AGENT, ...Object.fromEntries(new Headers(init.headers).entries()) },
    });
}

/**
 * 応答本文を文字列へ変換する
 *
 * Content-Type の charset を使い 無い場合や未知の場合は UTF-8 とみなす
 *
 * @param response - 応答
 * @returns 本文
 */
export async function readResponseText(response: Response): Promise<string> {
    const bytes = await response.arrayBuffer();
    const charset = /charset=["']?([^;"'\s]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
    try {
        // 任意の文字コード名を受けるため node:util の TextDecoder を使う 未知の名前は RangeError になる
        return new LabeledTextDecoder(charset ?? "utf-8").decode(bytes);
    } catch {
        return new TextDecoder("utf-8").decode(bytes);
    }
}

/**
 * 成功応答の本文をEUC-JPとして文字列へ変換する
 *
 * 不正なバイト列は置換文字になる
 *
 * @param url - リクエスト先
 * @param timeoutSeconds - タイムアウト秒
 * @returns 本文
 * @throws {HttpStatusError} 2xx以外の応答の場合
 */
export async function fetchEucJpHtml(url: string, timeoutSeconds: number): Promise<string> {
    const response = await requestWithTimeout(url, timeoutSeconds);
    if (!response.ok) {
        throw new HttpStatusError(response.status, url);
    }
    return new TextDecoder("euc-jp").decode(await response.arrayBuffer());
}
