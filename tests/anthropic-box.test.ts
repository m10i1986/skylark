//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { afterEach, describe, expect, test } from "bun:test";
import { ConfigError } from "../src/config.ts";
import { BOX_CHOICE_SCHEMA, BoxSelectionError, type BoxSelectionRequest } from "../src/predict/ai-box.ts";
import {
    createAnthropicBoxSelector,
    createAnthropicBoxSelectorFromEnvironment,
    DEFAULT_AI_BOX_MODEL,
    toSelectionError,
} from "../src/predict/anthropic-box.ts";
import { mockFetch } from "./mock-fetch.ts";

const API_KEY = "sk-ant-test-secret-key";
const REQUEST: BoxSelectionRequest = { system: "system text", user: "user text", schema: BOX_CHOICE_SCHEMA };
const CHOICE = { horseNumbers: [1, 2, 3, 4], reason: "理由", caution: "" };

// Messages API の応答 SDKは形を検証しないため 使う項目だけを持つ
function messageBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: JSON.stringify(CHOICE) }],
        stop_reason: "end_turn",
        stop_details: null,
        usage: { input_tokens: 10, output_tokens: 10 },
        ...overrides,
    });
}

function jsonResponse(body: string, status = 200): Response {
    return new Response(body, { status, headers: { "content-type": "application/json" } });
}

// 通信を差し替えた選定処理 再送で時間を使わないよう再送は0回にする
function selectorWith(handler: () => Response | Promise<Response>) {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const selector = createAnthropicBoxSelector({
        apiKey: API_KEY,
        maxRetries: 0,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            calls.push({
                url,
                headers: new Headers(init?.headers),
                body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
            });
            return handler();
        }) as typeof fetch,
    });
    return { calls, selector };
}

describe("createAnthropicBoxSelector", () => {
    test("応答のJSONとモデル名を返す", async () => {
        const { selector } = selectorWith(() => jsonResponse(messageBody({ model: "claude-opus-5-5" })));
        expect(await selector(REQUEST)).toEqual({ value: CHOICE, model: "claude-opus-5-5" });
    });

    test("既定のモデル 構造化出力 effort fallbacks を指定して送る", async () => {
        const { calls, selector } = selectorWith(() => jsonResponse(messageBody()));
        await selector(REQUEST);

        expect(calls).toHaveLength(1);
        const [call] = calls;
        expect(call?.url).toContain("/v1/messages");
        // 鍵を載せるヘッダー名はSDKの実装に任せる 鍵は本文やURLには載せない
        expect([...(call?.headers.values() ?? [])].some((value) => value.includes(API_KEY))).toBe(true);
        expect(call?.url).not.toContain(API_KEY);
        expect(JSON.stringify(call?.body)).not.toContain(API_KEY);
        expect(call?.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
        expect(call?.body).toMatchObject({
            model: DEFAULT_AI_BOX_MODEL,
            fallbacks: "default",
            system: "system text",
            messages: [{ role: "user", content: "user text" }],
            output_config: { effort: "medium", format: { type: "json_schema", schema: BOX_CHOICE_SCHEMA } },
        });
    });

    test("このモデルが受け付けない項目(thinking 無効化 sampling 強制tool_choice prefill)は送らない", async () => {
        const { calls, selector } = selectorWith(() => jsonResponse(messageBody()));
        await selector(REQUEST);
        const body = calls[0]?.body ?? {};
        for (const key of ["thinking", "temperature", "top_p", "top_k", "tool_choice", "tools"]) {
            expect(body).not.toHaveProperty(key);
        }
        const messages = body.messages as Array<{ role: string }>;
        expect(messages.map((message) => message.role)).toEqual(["user"]);
    });

    test("拒否(refusal)は回復可能な失敗として分類を添えて伝える", async () => {
        const { selector } = selectorWith(() =>
            jsonResponse(
                messageBody({
                    content: [],
                    stop_reason: "refusal",
                    stop_details: { type: "refusal", category: "general_harms", explanation: null },
                }),
            ),
        );
        const error = await selector(REQUEST).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(BoxSelectionError);
        expect((error as BoxSelectionError).isRecoverable).toBe(true);
        expect((error as BoxSelectionError).message).toContain("general_harms");
    });

    test("出力が途中で打ち切られた(max_tokens)場合は回復可能な失敗", async () => {
        const { selector } = selectorWith(() =>
            jsonResponse(messageBody({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"horse' }] })),
        );
        const error = await selector(REQUEST).catch((caught: unknown) => caught);
        expect((error as BoxSelectionError).isRecoverable).toBe(true);
        expect((error as BoxSelectionError).message).toContain("max_tokens");
    });

    test("応答がJSONでない場合は回復可能な失敗", async () => {
        const { selector } = selectorWith(() =>
            jsonResponse(messageBody({ content: [{ type: "text", text: "選びました: 1, 2, 3" }] })),
        );
        const error = await selector(REQUEST).catch((caught: unknown) => caught);
        expect((error as BoxSelectionError).isRecoverable).toBe(true);
        expect((error as BoxSelectionError).message).toContain("not valid JSON");
    });

    test("文章以外のブロック(thinking など)があっても 文章だけを読む", async () => {
        const { selector } = selectorWith(() =>
            jsonResponse(
                messageBody({
                    content: [
                        { type: "thinking", thinking: "", signature: "sig" },
                        { type: "text", text: JSON.stringify(CHOICE) },
                    ],
                }),
            ),
        );
        expect((await selector(REQUEST)).value).toEqual(CHOICE);
    });

    test.each([
        [429, true],
        [500, true],
        [529, true],
        [400, false],
        [401, false],
        [403, false],
        [404, false],
    ])("HTTP %i は回復可能=%p として扱う", async (status, isRecoverable) => {
        const { selector } = selectorWith(() =>
            jsonResponse(
                JSON.stringify({ type: "error", error: { type: "api_error", message: "failure detail" } }),
                status,
            ),
        );
        const error = await selector(REQUEST).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(BoxSelectionError);
        expect((error as BoxSelectionError).isRecoverable).toBe(isRecoverable);
    });

    test("認証の失敗は回復不能で 鍵の値を含めない", async () => {
        const { selector } = selectorWith(() =>
            jsonResponse(
                JSON.stringify({
                    type: "error",
                    error: { type: "authentication_error", message: `invalid x-api-key ${API_KEY}` },
                }),
                401,
            ),
        );
        const error = (await selector(REQUEST).catch((caught: unknown) => caught)) as BoxSelectionError;
        expect(error.isRecoverable).toBe(false);
        expect(error.message).toContain("ANTHROPIC_API_KEY");
        expect(error.message).not.toContain(API_KEY);
    });

    test("接続の失敗は回復可能", async () => {
        const { selector } = selectorWith(() => {
            throw new TypeError("fetch failed");
        });
        const error = await selector(REQUEST).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(BoxSelectionError);
        expect((error as BoxSelectionError).isRecoverable).toBe(true);
    });
});

describe("toSelectionError", () => {
    test("認証情報が無いときにSDKが投げる素の例外は 回復不能とし ANTHROPIC_API_KEY を案内する", () => {
        const error = toSelectionError(new Error("Could not resolve authentication method."));
        expect(error.isRecoverable).toBe(false);
        expect(error.message).toContain("ANTHROPIC_API_KEY");
    });

    test("例外でない値も扱える", () => {
        expect(toSelectionError("boom").isRecoverable).toBe(false);
    });

    test("長いメッセージは切り詰める", () => {
        expect(toSelectionError(new Error("x".repeat(1000))).message.length).toBeLessThan(400);
    });
});

describe("createAnthropicBoxSelectorFromEnvironment", () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    afterEach(() => {
        if (savedKey == null) {
            delete process.env.ANTHROPIC_API_KEY;
        } else {
            process.env.ANTHROPIC_API_KEY = savedKey;
        }
    });

    test("AI_BOX_MODEL でモデルを変えられる", async () => {
        process.env.ANTHROPIC_API_KEY = API_KEY;
        const bodies: Array<Record<string, unknown>> = [];
        const mock = mockFetch((_url, init) => {
            bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
            return jsonResponse(messageBody({ model: "claude-sonnet-5-5" }));
        });
        try {
            const selector = createAnthropicBoxSelectorFromEnvironment({ AI_BOX_MODEL: "claude-sonnet-5-5" });
            await selector(REQUEST);
        } finally {
            mock.restore();
        }
        expect(bodies[0]?.model).toBe("claude-sonnet-5-5");
    });

    test("AI_BOX_MODEL が空なら既定のモデルを使う", async () => {
        process.env.ANTHROPIC_API_KEY = API_KEY;
        const bodies: Array<Record<string, unknown>> = [];
        const mock = mockFetch((_url, init) => {
            bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
            return jsonResponse(messageBody());
        });
        try {
            await createAnthropicBoxSelectorFromEnvironment({ AI_BOX_MODEL: "" })(REQUEST);
        } finally {
            mock.restore();
        }
        expect(bodies[0]?.model).toBe(DEFAULT_AI_BOX_MODEL);
    });

    test("渡した環境変数の ANTHROPIC_API_KEY を使う(プロセスの環境変数ではなく)", async () => {
        delete process.env.ANTHROPIC_API_KEY;
        const authorizations: string[] = [];
        const mock = mockFetch((_url, init) => {
            authorizations.push([...new Headers(init?.headers).values()].join("|"));
            return jsonResponse(messageBody());
        });
        try {
            await createAnthropicBoxSelectorFromEnvironment({ ANTHROPIC_API_KEY: "sk-injected-key" })(REQUEST);
        } finally {
            mock.restore();
        }
        expect(authorizations[0]).toContain("sk-injected-key");
    });

    test("AI_BOX_TIMEOUT が数値でなければ設定の誤りにする", () => {
        expect(() => createAnthropicBoxSelectorFromEnvironment({ AI_BOX_TIMEOUT: "abc" })).toThrow(ConfigError);
    });
});
