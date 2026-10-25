//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConfigError } from "../src/config.ts";
import { BOX_CHOICE_SCHEMA, BoxSelectionError, type BoxSelectionRequest } from "../src/predict/ai-box.ts";
import {
    buildCliArguments,
    buildCliEnvironment,
    type CliRunInput,
    type CliRunResult,
    createClaudeCliBoxSelector,
    createClaudeCliBoxSelectorFromEnvironment,
    DEFAULT_AI_BOX_MODEL,
} from "../src/predict/claude-cli-box.ts";

const REQUEST: BoxSelectionRequest = { system: "system text", user: "user text", schema: BOX_CHOICE_SCHEMA };
const CHOICE = { horseNumbers: [1, 2, 3, 4], reason: "理由", caution: "" };

// claude -p --output-format json の実際の出力から 使う項目だけを残した形
function report(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        api_error_status: null,
        // 構造化出力はCLIの内部の道具で返すため tool_use になる
        stop_reason: "tool_use",
        num_turns: 2,
        result: JSON.stringify(CHOICE),
        structured_output: CHOICE,
        modelUsage: { "claude-opus-5-5": { inputTokens: 2, outputTokens: 261 } },
        ...overrides,
    });
}

// 失敗した実行 subtype は失敗でも success になる
function errorReport(result: string, status: number | null): string {
    return report({ is_error: true, api_error_status: status, result, structured_output: undefined, modelUsage: {} });
}

function runResult(overrides: Partial<CliRunResult> = {}): CliRunResult {
    return { exitCode: 0, stdout: report(), stderr: "", isTimedOut: false, isOutputTooLarge: false, ...overrides };
}

// 実行を差し替えた選定処理
function selectorReturning(result: CliRunResult | Error) {
    const inputs: CliRunInput[] = [];
    const selector = createClaudeCliBoxSelector({
        env: {},
        run: async (input) => {
            inputs.push(input);
            if (result instanceof Error) {
                throw result;
            }
            return result;
        },
    });
    return { inputs, selector };
}

async function failureOf(promise: Promise<unknown>): Promise<BoxSelectionError> {
    const error = await promise.then(
        () => undefined,
        (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(BoxSelectionError);
    return error as BoxSelectionError;
}

describe("createClaudeCliBoxSelector", () => {
    test("構造化出力の値と 使ったモデルを返す", async () => {
        const { selector } = selectorReturning(runResult());
        expect(await selector(REQUEST)).toEqual({ value: CHOICE, model: "claude-opus-5-5" });
    });

    test("利用者の文章は標準入力で渡し 引数に含めない", async () => {
        const { inputs, selector } = selectorReturning(runResult());
        await selector({ ...REQUEST, user: "秘密にしたい馬名 USER-ONLY-TEXT" });

        const [input] = inputs;
        expect(input?.stdin).toBe("秘密にしたい馬名 USER-ONLY-TEXT");
        expect(input?.args.join("\n")).not.toContain("USER-ONLY-TEXT");
        expect(input?.command).toBe("claude");
    });

    test("ツール 設定ファイル 会話の保存を使わず 構造化出力とモデルと effort を指定する", () => {
        const args = buildCliArguments(REQUEST, "claude-opus-5-5");
        expect(args).toContain("-p");
        expect(args).toContain("--output-format=json");
        expect(args).toContain("--no-session-persistence");
        expect(args).toContain("--safe-mode");
        expect(args).toContain("--permission-prompts=none");
        expect(args).toContain("--model=claude-opus-5-5");
        expect(args).toContain("--effort=medium");
        expect(args).toContain("--system-prompt=system text");
        expect(args).toContain(`--json-schema=${JSON.stringify(BOX_CHOICE_SCHEMA)}`);
        // ツールは空の値で無効にする
        expect(args[args.indexOf("--tools") + 1]).toBe("");
        // 認証がAPIキーに限られるため使わない
        expect(args).not.toContain("--bare");
    });

    test("先頭が - の文章も 別の引数として解釈されない", () => {
        const args = buildCliArguments({ ...REQUEST, system: "--tools Bash" }, "m");
        expect(args).toContain("--system-prompt=--tools Bash");
        expect(args.filter((arg) => arg === "--tools")).toHaveLength(1);
    });

    test("既定のモデルを使い 設定したモデルとCLIの場所とタイムアウトを渡す", async () => {
        const first = selectorReturning(runResult());
        await first.selector(REQUEST);
        expect(first.inputs[0]?.args).toContain(`--model=${DEFAULT_AI_BOX_MODEL}`);
        expect(first.inputs[0]?.timeoutMs).toBe(120_000);

        const inputs: CliRunInput[] = [];
        const selector = createClaudeCliBoxSelector({
            env: {},
            model: "claude-sonnet-5-5",
            command: "/opt/bin/claude",
            timeoutSeconds: 30,
            run: async (input) => {
                inputs.push(input);
                return runResult();
            },
        });
        await selector(REQUEST);
        expect(inputs[0]).toMatchObject({ command: "/opt/bin/claude", timeoutMs: 30_000 });
        expect(inputs[0]?.args).toContain("--model=claude-sonnet-5-5");
    });

    test("構造化出力が無ければ result の文章をJSONとして読む", async () => {
        const { selector } = selectorReturning(
            runResult({ stdout: report({ structured_output: undefined, result: JSON.stringify(CHOICE) }) }),
        );
        expect((await selector(REQUEST)).value).toEqual(CHOICE);
    });

    test("構造化出力もJSONの result も無ければ回復可能な失敗", async () => {
        const { selector } = selectorReturning(
            runResult({ stdout: report({ structured_output: undefined, result: "選びました: 1, 2, 3" }) }),
        );
        const error = await failureOf(selector(REQUEST));
        expect(error.isRecoverable).toBe(true);
        expect(error.message).toContain("no structured output");
    });

    test("標準エラー出力に警告があっても 失敗にしない", async () => {
        const { selector } = selectorReturning(runResult({ stderr: "Warning: Advisor disabled" }));
        expect((await selector(REQUEST)).value).toEqual(CHOICE);
    });

    test("応答したモデルは 要求したモデルがあればそれ 無ければ最も多く出力したもの", async () => {
        const usage = {
            "claude-haiku-4-5-20251001": { outputTokens: 5 },
            "claude-opus-5-5": { outputTokens: 100 },
        };
        const exact = selectorReturning(runResult({ stdout: report({ modelUsage: usage }) }));
        expect((await exact.selector(REQUEST)).model).toBe("claude-opus-5-5");

        const alias = createClaudeCliBoxSelector({
            env: {},
            model: "opus",
            run: async () => runResult({ stdout: report({ modelUsage: usage }) }),
        });
        expect((await alias(REQUEST)).model).toBe("claude-opus-5-5");

        const none = createClaudeCliBoxSelector({
            env: {},
            model: "opus",
            run: async () => runResult({ stdout: report({ modelUsage: {} }) }),
        });
        expect((await none(REQUEST)).model).toBe("opus");
    });

    test("拒否(refusal)と出力の打ち切り(max_tokens)は回復可能な失敗", async () => {
        for (const reason of ["refusal", "max_tokens"]) {
            const { selector } = selectorReturning(runResult({ stdout: report({ stop_reason: reason }) }));
            const error = await failureOf(selector(REQUEST));
            expect(error.isRecoverable).toBe(true);
            expect(error.message).toContain(reason);
        }
    });

    test.each([
        [429, true],
        [500, true],
        [529, true],
        [400, false],
        [401, false],
        [403, false],
        [404, false],
    ])("CLIが報告したHTTP %i は回復可能=%p として扱う", async (status, isRecoverable) => {
        const { selector } = selectorReturning(
            runResult({ exitCode: 1, stdout: errorReport("failure detail", status) }),
        );
        const error = await failureOf(selector(REQUEST));
        expect(error.isRecoverable).toBe(isRecoverable);
    });

    test("ログインしていない場合は回復不能で ログインの方法を案内する", async () => {
        const { selector } = selectorReturning(
            runResult({ exitCode: 1, stdout: errorReport("Not logged in · Please run /login", null) }),
        );
        const error = await failureOf(selector(REQUEST));
        expect(error.isRecoverable).toBe(false);
        expect(error.message).toContain("claude auth login");
    });

    test("存在しないモデルは回復不能で CLIの説明を載せる", async () => {
        const { selector } = selectorReturning(
            runResult({
                exitCode: 1,
                stdout: errorReport("There's an issue with the selected model (nonexistent-model-x).", 404),
            }),
        );
        const error = await failureOf(selector(REQUEST));
        expect(error.isRecoverable).toBe(false);
        expect(error.message).toContain("nonexistent-model-x");
    });

    test("原因が分からない失敗は回復不能", async () => {
        const { selector } = selectorReturning(runResult({ exitCode: 1, stdout: errorReport("something odd", null) }));
        expect((await failureOf(selector(REQUEST))).isRecoverable).toBe(false);
    });

    test("長いエラーの説明は切り詰める", async () => {
        const { selector } = selectorReturning(runResult({ exitCode: 1, stdout: errorReport("x".repeat(1000), 400) }));
        expect((await failureOf(selector(REQUEST))).message.length).toBeLessThan(400);
    });

    test("時間切れと出力の超過は回復可能", async () => {
        const timedOut = selectorReturning(runResult({ isTimedOut: true, exitCode: null, stdout: "" }));
        const timeoutError = await failureOf(timedOut.selector(REQUEST));
        expect(timeoutError.isRecoverable).toBe(true);
        expect(timeoutError.message).toContain("timed out");

        const tooLarge = selectorReturning(runResult({ isOutputTooLarge: true, exitCode: null, stdout: "" }));
        const sizeError = await failureOf(tooLarge.selector(REQUEST));
        expect(sizeError.isRecoverable).toBe(true);
        expect(sizeError.message).toContain("too large");
    });

    test("JSONでない出力は回復可能な失敗で 終了コードと標準エラー出力を添える", async () => {
        const failed = selectorReturning(runResult({ exitCode: 3, stdout: "", stderr: "boom happened" }));
        const error = await failureOf(failed.selector(REQUEST));
        expect(error.isRecoverable).toBe(true);
        expect(error.message).toContain("exit code 3");
        expect(error.message).toContain("boom happened");

        const garbled = selectorReturning(runResult({ stdout: "not json" }));
        expect((await failureOf(garbled.selector(REQUEST))).message).toContain("not valid JSON");

        const array = selectorReturning(runResult({ stdout: "[1]" }));
        expect((await failureOf(array.selector(REQUEST))).isRecoverable).toBe(true);
    });

    test("実行ファイルが無い場合は回復不能で CLAUDE_CLI_PATH を案内する", async () => {
        const { selector } = selectorReturning(Object.assign(new Error("spawn failed"), { code: "ENOENT" }));
        const error = await failureOf(selector(REQUEST));
        expect(error.isRecoverable).toBe(false);
        expect(error.message).toContain("CLAUDE_CLI_PATH");
    });

    test("起動できないその他の例外も回復不能", async () => {
        const { selector } = selectorReturning(Object.assign(new Error("permission denied"), { code: "EACCES" }));
        const error = await failureOf(selector(REQUEST));
        expect(error.isRecoverable).toBe(false);
        expect(error.message).toContain("permission denied");
    });
});

describe("buildCliEnvironment", () => {
    test("ログインと通信に必要なものだけを渡し 秘密情報は渡さない", () => {
        const passed = buildCliEnvironment({
            PATH: "/usr/bin",
            HOME: "/home/user",
            LANG: "ja_JP.UTF-8",
            LC_ALL: "C",
            XDG_CONFIG_HOME: "/home/user/.config",
            HTTPS_PROXY: "http://proxy:8080",
            CLAUDE_CONFIG_DIR: "/home/user/.claude-alt",
            CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
            ANTHROPIC_API_KEY: "sk-ant-secret",
            ANTHROPIC_AUTH_TOKEN: "auth-secret",
            POSTGRES_PASSWORD: "db-secret",
            DATABASE_URL: "postgres://user:db-secret@localhost/skylark",
            NETKEIABA_PASSWORD: "site-secret",
            CLAUDE_CODE_SESSION_ID: "parent-session",
            UNSET: undefined,
        });
        expect(passed).toEqual({
            PATH: "/usr/bin",
            HOME: "/home/user",
            LANG: "ja_JP.UTF-8",
            LC_ALL: "C",
            XDG_CONFIG_HOME: "/home/user/.config",
            HTTPS_PROXY: "http://proxy:8080",
            CLAUDE_CONFIG_DIR: "/home/user/.claude-alt",
            CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
        });
    });

    test("選定処理は渡された環境変数から子プロセスの環境変数を作る", async () => {
        const { inputs, selector } = selectorReturning(runResult());
        await selector(REQUEST);
        expect(inputs[0]?.env).toEqual({});

        const inputs2: CliRunInput[] = [];
        const selector2 = createClaudeCliBoxSelector({
            env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-secret" },
            run: async (input) => {
                inputs2.push(input);
                return runResult();
            },
        });
        await selector2(REQUEST);
        expect(inputs2[0]?.env).toEqual({ PATH: "/bin" });
    });
});

describe("createClaudeCliBoxSelectorFromEnvironment", () => {
    // 渡された設定を調べるため 実行を差し替える
    async function inputOf(env: Record<string, string>): Promise<CliRunInput | undefined> {
        let captured: CliRunInput | undefined;
        const selector = createClaudeCliBoxSelectorFromEnvironment(env, async (input) => {
            captured = input;
            return runResult();
        });
        await selector(REQUEST);
        return captured;
    }

    test("AI_BOX_MODEL CLAUDE_CLI_PATH AI_BOX_TIMEOUT で設定を変えられる", async () => {
        const input = await inputOf({
            AI_BOX_MODEL: "claude-sonnet-5-5",
            CLAUDE_CLI_PATH: "/opt/bin/claude",
            AI_BOX_TIMEOUT: "45",
        });
        expect(input).toMatchObject({ command: "/opt/bin/claude", timeoutMs: 45_000 });
        expect(input?.args).toContain("--model=claude-sonnet-5-5");
    });

    test("空の設定は未設定として既定の値を使う", async () => {
        const input = await inputOf({ AI_BOX_MODEL: "", CLAUDE_CLI_PATH: "", AI_BOX_TIMEOUT: "" });
        expect(input).toMatchObject({ command: "claude", timeoutMs: 120_000 });
        expect(input?.args).toContain(`--model=${DEFAULT_AI_BOX_MODEL}`);
    });

    test("渡した環境変数から子プロセスの環境変数を作る(プロセスの環境変数ではなく)", async () => {
        const input = await inputOf({ HOME: "/injected/home", ANTHROPIC_API_KEY: "sk-ant-secret" });
        expect(input?.env).toEqual({ HOME: "/injected/home" });
    });

    test("AI_BOX_TIMEOUT が正の数でなければ設定の誤りにする", () => {
        for (const value of ["abc", "0", "-5"]) {
            expect(() => createClaudeCliBoxSelectorFromEnvironment({ AI_BOX_TIMEOUT: value })).toThrow(ConfigError);
        }
    });
});

// 偽の実行ファイルで 実際の子プロセスの起動を確かめる(本物のCLIは呼ばない)
describe("runClaudeCli with a fake executable", () => {
    const directories: string[] = [];

    afterEach(async () => {
        await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    });

    // 実行ファイルと 記録の置き場を作る スクリプトは置き場を受け取って作る
    async function fakeCli(
        script: string | ((directory: string) => string),
    ): Promise<{ command: string; directory: string }> {
        const directory = await mkdtemp(path.join(tmpdir(), "skylark-fake-cli-"));
        directories.push(directory);
        const command = path.join(directory, "claude");
        const body = typeof script === "string" ? script : script(directory);
        await writeFile(command, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        return { command, directory };
    }

    test("標準入力と引数を渡し 空の一時ディレクトリーで 許可した環境変数だけで実行する", async () => {
        const { command, directory } = await fakeCli((dir) =>
            [
                `cat > "${dir}/stdin.txt"`,
                `pwd > "${dir}/cwd.txt"`,
                `printf '%s\\n' "$@" > "${dir}/args.txt"`,
                `env > "${dir}/env.txt"`,
                `printf '%s' '${report()}'`,
            ].join("\n"),
        );

        const selector = createClaudeCliBoxSelector({
            command,
            env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "sk-ant-secret", POSTGRES_PASSWORD: "db-secret" },
        });
        const response = await selector({ system: "system text", user: "日本語の\n依頼文", schema: BOX_CHOICE_SCHEMA });

        expect(response).toEqual({ value: CHOICE, model: "claude-opus-5-5" });
        expect(await readFile(path.join(directory, "stdin.txt"), "utf8")).toBe("日本語の\n依頼文");
        const args = (await readFile(path.join(directory, "args.txt"), "utf8")).split("\n");
        expect(args).toContain("--safe-mode");
        expect(args).toContain("--system-prompt=system text");
        const env = await readFile(path.join(directory, "env.txt"), "utf8");
        expect(env).toContain("PATH=");
        expect(env).not.toContain("sk-ant-secret");
        expect(env).not.toContain("db-secret");

        // 作業場所は 作業後に消える一時ディレクトリー
        const cwd = (await readFile(path.join(directory, "cwd.txt"), "utf8")).trim();
        expect(cwd).not.toBe(process.cwd());
        expect(cwd).toContain("skylark-claude-");
        await expect(stat(cwd)).rejects.toThrow();
    });

    test("時間切れでは子プロセスを止めて回復可能な失敗にする", async () => {
        const { command } = await fakeCli("exec sleep 30");
        const selector = createClaudeCliBoxSelector({ command, env: { PATH: process.env.PATH }, timeoutSeconds: 0.3 });

        const started = Date.now();
        const error = await failureOf(selector(REQUEST));
        expect(error.isRecoverable).toBe(true);
        expect(error.message).toContain("timed out");
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    test("SIGTERM を無視する子プロセスも 猶予の後に強制終了する", async () => {
        const { command } = await fakeCli("trap '' TERM\nwhile true; do sleep 0.1; done");
        const selector = createClaudeCliBoxSelector({ command, env: { PATH: process.env.PATH }, timeoutSeconds: 0.3 });

        const started = Date.now();
        const error = await failureOf(selector(REQUEST));
        expect(error.message).toContain("timed out");
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    test("子プロセスの子がパイプを握り続けても 時間切れで返る", async () => {
        // 背景の sleep が標準出力と標準エラー出力を引き継ぐため 本体を止めてもパイプは閉じない
        const { command } = await fakeCli("sleep 8 &\nexec sleep 30");
        const selector = createClaudeCliBoxSelector({ command, env: { PATH: process.env.PATH }, timeoutSeconds: 0.3 });

        const started = Date.now();
        const error = await failureOf(selector(REQUEST));
        expect(error.isRecoverable).toBe(true);
        expect(error.message).toContain("timed out");
        expect(Date.now() - started).toBeLessThan(5_000);
    }, 40_000);

    test("出力が上限を超えたら止めて回復可能な失敗にする", async () => {
        const { command } = await fakeCli("head -c 3000000 /dev/zero | tr '\\0' 'a'");
        const selector = createClaudeCliBoxSelector({ command, env: { PATH: process.env.PATH } });

        const error = await failureOf(selector(REQUEST));
        expect(error.isRecoverable).toBe(true);
        expect(error.message).toContain("too large");
    });

    test("0以外の終了コードと標準エラー出力を伝える", async () => {
        const { command } = await fakeCli("echo 'login required somewhere' >&2\nexit 3");
        const selector = createClaudeCliBoxSelector({ command, env: { PATH: process.env.PATH } });

        const error = await failureOf(selector(REQUEST));
        expect(error.message).toContain("exit code 3");
        expect(error.message).toContain("login required somewhere");
    });

    test("実行ファイルが無ければ回復不能な失敗にする", async () => {
        const selector = createClaudeCliBoxSelector({
            command: path.join(tmpdir(), "skylark-no-such-claude"),
            env: { PATH: process.env.PATH },
        });
        const error = await failureOf(selector(REQUEST));
        expect(error.isRecoverable).toBe(false);
        expect(error.message).toContain("CLAUDE_CLI_PATH");
    });
});
