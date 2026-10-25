//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

// Claude API(Anthropic公式SDK)で 3連単Boxの選定を依頼する
// このファイルだけが SDK を読み込む 使わない処理(-B 以外)が SDK を読み込まないよう 呼び出し側は必要になった時点で import する

import Anthropic from "@anthropic-ai/sdk";

import { readNumberEnv } from "../config.ts";
import { BoxSelectionError, type BoxSelectionRequest, type BoxSelector } from "./ai-box.ts";

/** 既定のモデル */
export const DEFAULT_AI_BOX_MODEL = "claude-opus-5-5";

// 応答の上限 推論(thinking)の分も含むため 短い応答でも余裕を持たせる
const MAX_OUTPUT_TOKENS = 16_000;
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_RETRIES = 2;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Claude API へ接続する設定 */
export type AnthropicBoxSelectorOptions = {
    // 省略するとSDKが環境変数(ANTHROPIC_API_KEY など)から探す
    apiKey?: string;
    model?: string;
    timeoutSeconds?: number;
    // 同じ依頼を再送する最大回数
    maxRetries?: number;
    // テストで通信を差し替えるため
    fetch?: typeof fetch;
};

// 外部の文章は長くなり得るため 例外に載せる前に切る
function shorten(text: string, maxChars = 200): string {
    const characters = Array.from(text);
    return characters.length <= maxChars ? text : `${characters.slice(0, maxChars).join("")}…`;
}

/**
 * SDKの例外を 他のレースでは成功し得る一時的な失敗(回復可能)と それ以外に分ける
 *
 * 認証・権限・モデル名・依頼の形式の誤りは どのレースでも同じ理由で失敗するため回復不能とする
 *
 * @param error - 呼び出しで発生した例外
 * @returns 呼び出し側へ伝える例外 原因を cause に持つ
 */
export function toSelectionError(error: unknown): BoxSelectionError {
    if (error instanceof Anthropic.APIConnectionError) {
        // タイムアウトを含む
        return new BoxSelectionError(`Claude API connection failed: ${shorten(error.message)}`, true, {
            cause: error,
        });
    }
    if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError) {
        return new BoxSelectionError(`Claude API is temporarily unavailable (${error.status})`, true, {
            cause: error,
        });
    }
    if (error instanceof Anthropic.AuthenticationError) {
        return new BoxSelectionError(
            "Claude API authentication failed: check ANTHROPIC_API_KEY (the key is not shown)",
            false,
            { cause: error },
        );
    }
    if (error instanceof Anthropic.APIError) {
        return new BoxSelectionError(`Claude API error (${error.status}): ${shorten(error.message)}`, false, {
            cause: error,
        });
    }
    // 認証情報が無い場合など SDKが呼び出し前に投げる例外
    return new BoxSelectionError(
        `Claude API could not be called (set ANTHROPIC_API_KEY): ${shorten(error instanceof Error ? error.message : String(error))}`,
        false,
        { cause: error },
    );
}

/**
 * Claude API で選定を依頼する処理を作る
 *
 * 構造化出力(JSONスキーマ)で応答を受け取る thinking は無効にできないモデルのため指定せず effort は medium にする
 * 拒否(refusal)に備え サーバー側の fallbacks を有効にする 応答の形式は呼び出し側(parseBoxChoice)が検証する
 *
 * @param options - 接続の設定
 * @returns 選定を依頼する処理
 */
export function createAnthropicBoxSelector(options: AnthropicBoxSelectorOptions = {}): BoxSelector {
    const model = options.model ?? DEFAULT_AI_BOX_MODEL;
    const client = new Anthropic({
        apiKey: options.apiKey,
        timeout: (options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
        maxRetries: options.maxRetries ?? MAX_RETRIES,
        fetch: options.fetch,
    });

    return async (request: BoxSelectionRequest) => {
        let response: Awaited<ReturnType<typeof client.beta.messages.create>>;
        try {
            response = await client.beta.messages.create({
                model,
                max_tokens: MAX_OUTPUT_TOKENS,
                betas: [FALLBACK_BETA],
                fallbacks: "default",
                system: request.system,
                messages: [{ role: "user", content: request.user }],
                output_config: {
                    effort: "medium",
                    format: { type: "json_schema", schema: { ...request.schema } },
                },
            });
        } catch (error) {
            throw toSelectionError(error);
        }

        // 拒否と打ち切りは 内容を読む前に確かめる
        if (response.stop_reason === "refusal") {
            const category = response.stop_details?.category ?? "unknown";
            throw new BoxSelectionError(`Claude declined the request (${category})`, true);
        }
        if (response.stop_reason === "max_tokens") {
            throw new BoxSelectionError("Claude's response was cut off (max_tokens)", true);
        }

        const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
        let value: unknown;
        try {
            value = JSON.parse(text);
        } catch (error) {
            throw new BoxSelectionError("Claude's response was not valid JSON", true, { cause: error });
        }
        return { value, model: response.model };
    };
}

/**
 * 環境変数の設定で Claude API の選定処理を作る
 *
 * 認証情報は ANTHROPIC_API_KEY で渡す(未設定ならSDKが他の認証情報を探す) モデルは AI_BOX_MODEL で変えられる
 *
 * @param env - 環境変数
 * @returns 選定を依頼する処理
 * @throws {ConfigError} AI_BOX_TIMEOUT が数値でない場合
 */
export function createAnthropicBoxSelectorFromEnvironment(
    env: Readonly<Record<string, string | undefined>>,
): BoxSelector {
    const model = env.AI_BOX_MODEL;
    return createAnthropicBoxSelector({
        // 空の値は未設定として扱い SDKが他の認証情報(トークンやプロファイル)を探せるようにする
        apiKey: env.ANTHROPIC_API_KEY === "" ? undefined : env.ANTHROPIC_API_KEY,
        model: model == null || model === "" ? undefined : model,
        timeoutSeconds: readNumberEnv(env, "AI_BOX_TIMEOUT", DEFAULT_TIMEOUT_SECONDS),
    });
}
