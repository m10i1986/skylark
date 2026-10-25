//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

// Claude CLI(claude -p)で 3連単Boxの選定を依頼する
// 認証はCLIのログインに任せる 外部由来の文章は標準入力で渡し シェルは介さない
// -B のときだけ使うため 呼び出し側は必要になった時点で import する

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConfigError, readNumberEnv } from "../config.ts";
import { BoxSelectionError, type BoxSelectionRequest, type BoxSelectionResponse, type BoxSelector } from "./ai-box.ts";

/** 既定のモデル */
export const DEFAULT_AI_BOX_MODEL = "claude-opus-5-5";
/** 既定のCLIの実行ファイル(PATHから探す) */
export const DEFAULT_CLAUDE_COMMAND = "claude";

const DEFAULT_TIMEOUT_SECONDS = 120;
// 終了の合図(SIGTERM)の後 強制終了するまでの猶予
const KILL_GRACE_MS = 2_000;
// 子プロセスの終了後 出力を読み切るまでの猶予 孫プロセスがパイプを握り続けても待ち続けないため
const PIPE_DRAIN_MS = 1_000;
// CLIの出力の上限 通常は数KBのため 暴走した出力でメモリーを使い切らないための歯止め
const MAX_OUTPUT_BYTES = 1024 * 1024;

// CLIへ渡す環境変数 ログインの保管場所(HOME)と通信の設定に限る
// DBのパスワードなどこのアプリの秘密情報と ANTHROPIC_API_KEY は渡さない(キーがあるとCLIはAPI課金で動くため)
const PASSED_ENV_NAMES: ReadonlySet<string> = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LANGUAGE",
    "TMPDIR",
    "TZ",
    "CLAUDE_CONFIG_DIR",
    // claude setup-token で作る長期トークン
    "CLAUDE_CODE_OAUTH_TOKEN",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
]);
const PASSED_ENV_PREFIXES: readonly string[] = ["LC_", "XDG_"];

type Environment = Readonly<Record<string, string | undefined>>;

/** CLIの実行の依頼 */
export type CliRunInput = {
    command: string;
    args: readonly string[];
    // 標準入力へ渡す文章
    stdin: string;
    env: Readonly<Record<string, string>>;
    timeoutMs: number;
};

/** CLIの実行の結果 */
export type CliRunResult = {
    // 時間切れや出力超過で止めた場合は意味を持たない
    exitCode: number | null;
    stdout: string;
    stderr: string;
    isTimedOut: boolean;
    // 出力が上限を超えたため止めた
    isOutputTooLarge: boolean;
};

/** CLIを実行する処理 起動できない場合は例外を投げる テストで差し替えるため */
export type CliRunner = (input: CliRunInput) => Promise<CliRunResult>;

/** Claude CLI の設定 */
export type ClaudeCliBoxSelectorOptions = {
    model?: string;
    // 実行ファイルの名前またはパス
    command?: string;
    timeoutSeconds?: number;
    // CLIへ渡す環境変数の元 省略するとプロセスの環境変数
    env?: Environment;
    run?: CliRunner;
};

// 外部の文章は長くなり得るため 例外に載せる前に切る
function shorten(text: string, maxChars = 200): string {
    const characters = Array.from(text);
    return characters.length <= maxChars ? text : `${characters.slice(0, maxChars).join("")}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * CLIへ渡す環境変数を作る
 *
 * @param env - 元の環境変数
 * @returns 許可した名前だけを持つ環境変数
 */
export function buildCliEnvironment(env: Environment): Record<string, string> {
    const passed: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
        if (value == null) {
            continue;
        }
        if (PASSED_ENV_NAMES.has(name) || PASSED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
            passed[name] = value;
        }
    }
    return passed;
}

/**
 * CLIの引数を作る
 *
 * ツールと設定ファイル(CLAUDE.md フック MCP)は使わず 会話も保存しない 利用者の文章は引数に含めない(標準入力で渡す)
 * --bare は認証がAPIキーに限られるため使わない
 *
 * @param request - 依頼
 * @param model - モデル
 * @returns 引数
 */
export function buildCliArguments(request: BoxSelectionRequest, model: string): string[] {
    return [
        "-p",
        "--output-format=json",
        "--no-session-persistence",
        "--safe-mode",
        "--tools",
        "",
        "--permission-prompts=none",
        `--model=${model}`,
        "--effort=medium",
        `--system-prompt=${request.system}`,
        `--json-schema=${JSON.stringify(request.schema)}`,
    ];
}

// 出力を上限まで集める 超えたら onOverflow を呼んで読むのをやめる
function collectLimited(stream: ReadableStream<Uint8Array>, maxBytes: number, onOverflow: () => void) {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const finished = (async (): Promise<void> => {
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                total += value.byteLength;
                if (total > maxBytes) {
                    onOverflow();
                    break;
                }
                chunks.push(value);
            }
        } catch {
            // 読むのを打ち切った場合 集めた分だけを使う
        }
    })();
    return {
        // EOFか上限超過か打ち切りで読み終えたときに解決する
        finished,
        // ここまでに集めた文章
        text: (): string => new TextDecoder().decode(Buffer.concat(chunks)),
        // 読むのを打ち切る
        stop: async (): Promise<void> => {
            await reader.cancel().catch(() => undefined);
            await finished;
        },
    };
}

/**
 * CLIを子プロセスとして実行する
 *
 * シェルを介さず 空の一時ディレクトリーを作業場所にする(プロジェクトの設定やファイルを読ませない)
 * 時間切れはSIGTERM 猶予の後にSIGKILLで止める
 *
 * @param input - 実行の依頼
 * @returns 実行の結果
 * @throws 起動できない場合(実行ファイルが無いなど)
 */
export const runClaudeCli: CliRunner = async (input) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "skylark-claude-"));
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        const child = Bun.spawn({
            cmd: [input.command, ...input.args],
            cwd,
            env: { ...input.env },
            stdin: new TextEncoder().encode(input.stdin),
            stdout: "pipe",
            stderr: "pipe",
        });
        let isTimedOut = false;
        let isOutputTooLarge = false;
        timeoutTimer = setTimeout(() => {
            isTimedOut = true;
            child.kill("SIGTERM");
            forceTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        }, input.timeoutMs);
        const stopForOverflow = (): void => {
            isOutputTooLarge = true;
            child.kill("SIGKILL");
        };

        const stdout = collectLimited(child.stdout, MAX_OUTPUT_BYTES, stopForOverflow);
        const stderr = collectLimited(child.stderr, MAX_OUTPUT_BYTES, stopForOverflow);
        const exitCode = await child.exited;
        // 孫プロセスがパイプを握っていると EOF が来ないため 終了後は短い猶予で読み切って打ち切る
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                Promise.all([stdout.finished, stderr.finished]),
                new Promise<void>((resolve) => {
                    drainTimer = setTimeout(resolve, PIPE_DRAIN_MS);
                }),
            ]);
        } finally {
            clearTimeout(drainTimer);
        }
        await Promise.all([stdout.stop(), stderr.stop()]);
        return { exitCode, stdout: stdout.text(), stderr: stderr.text(), isTimedOut, isOutputTooLarge };
    } finally {
        clearTimeout(timeoutTimer);
        clearTimeout(forceTimer);
        await rm(cwd, { recursive: true, force: true });
    }
};

// 起動できなかった例外を 呼び出し側へ伝える例外にする どのレースでも同じ理由で失敗するため回復不能
function toSpawnError(error: unknown, command: string): BoxSelectionError {
    const code = isRecord(error) ? error.code : undefined;
    if (code === "ENOENT") {
        return new BoxSelectionError(
            `Claude CLI was not found (${shorten(command)}): install it, or set CLAUDE_CLI_PATH`,
            false,
            { cause: error },
        );
    }
    return new BoxSelectionError(
        `Claude CLI could not be started: ${shorten(error instanceof Error ? error.message : String(error))}`,
        false,
        { cause: error },
    );
}

// CLIが報告した失敗を 他のレースでは成功し得る一時的な失敗(回復可能)と それ以外に分ける
function toReportedError(report: Record<string, unknown>): BoxSelectionError {
    const status = typeof report.api_error_status === "number" ? report.api_error_status : null;
    const message = typeof report.result === "string" ? report.result : "";
    if (status === 429 || (status != null && status >= 500)) {
        return new BoxSelectionError(`Claude is temporarily unavailable (${status})`, true);
    }
    if (status === 401 || status === 403 || (status == null && /not logged in|\/login/i.test(message))) {
        return new BoxSelectionError(
            'Claude CLI authentication failed: run "claude auth login" (or set CLAUDE_CODE_OAUTH_TOKEN)',
            false,
        );
    }
    // モデル名や依頼の形式の誤りなど 設定の誤りはどのレースでも同じ理由で失敗する
    return new BoxSelectionError(`Claude CLI reported an error (${status ?? "no status"}): ${shorten(message)}`, false);
}

// 使ったモデルの名前 要求したモデルがあればそれ 無ければ最も多く出力したもの(別名で要求した場合)
function modelOf(usage: unknown, requested: string): string {
    if (!isRecord(usage) || Object.hasOwn(usage, requested)) {
        return requested;
    }
    let best = requested;
    let bestTokens = -1;
    for (const [name, entry] of Object.entries(usage)) {
        const tokens = isRecord(entry) && typeof entry.outputTokens === "number" ? entry.outputTokens : 0;
        if (tokens > bestTokens) {
            best = name;
            bestTokens = tokens;
        }
    }
    return best;
}

// 構造化出力の値 無ければ result の文章をJSONとして読む
function structuredValueOf(report: Record<string, unknown>): unknown {
    if (report.structured_output != null) {
        return report.structured_output;
    }
    if (typeof report.result === "string") {
        try {
            return JSON.parse(report.result);
        } catch {
            // 下で扱う
        }
    }
    throw new BoxSelectionError("Claude's response had no structured output", true);
}

/**
 * CLIの実行結果を選定の応答にする
 *
 * 終了コードと subtype は失敗でも成功に見える値が入るため 標準出力のJSONの is_error で判断する
 * 標準エラー出力は警告が混じるため 失敗の判断には使わない
 *
 * @param result - 実行の結果
 * @param requestedModel - 要求したモデル
 * @param timeoutSeconds - 時間切れの案内に載せる秒数
 * @returns 応答
 * @throws {BoxSelectionError} 応答を得られなかった場合
 */
export function interpretCliResult(
    result: CliRunResult,
    requestedModel: string,
    timeoutSeconds: number,
): BoxSelectionResponse {
    if (result.isTimedOut) {
        throw new BoxSelectionError(`Claude CLI timed out (${timeoutSeconds}s)`, true);
    }
    if (result.isOutputTooLarge) {
        throw new BoxSelectionError("Claude CLI output was too large", true);
    }

    let report: unknown;
    try {
        report = JSON.parse(result.stdout);
    } catch (error) {
        const detail = result.exitCode === 0 ? "its output was not valid JSON" : `exit code ${result.exitCode}`;
        throw new BoxSelectionError(
            `Claude CLI failed (${detail}): ${shorten(result.stderr.trim() || result.stdout.trim())}`,
            true,
            { cause: error },
        );
    }
    if (!isRecord(report)) {
        throw new BoxSelectionError("Claude CLI output was not a JSON object", true);
    }
    if (report.is_error === true) {
        throw toReportedError(report);
    }
    // 拒否と打ち切りは 内容を読む前に確かめる
    if (report.stop_reason === "refusal") {
        throw new BoxSelectionError("Claude declined the request (refusal)", true);
    }
    if (report.stop_reason === "max_tokens") {
        throw new BoxSelectionError("Claude's response was cut off (max_tokens)", true);
    }
    return { value: structuredValueOf(report), model: modelOf(report.modelUsage, requestedModel) };
}

/**
 * Claude CLI で選定を依頼する処理を作る
 *
 * 構造化出力(JSONスキーマ)で応答を受け取る 応答の形式は呼び出し側(parseBoxChoice)が検証する
 * 失敗しても再送しない(再送が要るならCLI側が行う) 時間切れは回復可能として扱う
 *
 * @param options - CLIの設定
 * @returns 選定を依頼する処理
 */
export function createClaudeCliBoxSelector(options: ClaudeCliBoxSelectorOptions = {}): BoxSelector {
    const model = options.model ?? DEFAULT_AI_BOX_MODEL;
    const command = options.command ?? DEFAULT_CLAUDE_COMMAND;
    const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const run = options.run ?? runClaudeCli;
    const env = buildCliEnvironment(options.env ?? process.env);

    return async (request: BoxSelectionRequest) => {
        let result: CliRunResult;
        try {
            result = await run({
                command,
                args: buildCliArguments(request, model),
                stdin: request.user,
                env,
                timeoutMs: timeoutSeconds * 1000,
            });
        } catch (error) {
            throw toSpawnError(error, command);
        }
        return interpretCliResult(result, model, timeoutSeconds);
    };
}

/**
 * 環境変数の設定で Claude CLI の選定処理を作る
 *
 * 認証はCLIのログイン(claude auth login)に任せる モデルは AI_BOX_MODEL 実行ファイルは CLAUDE_CLI_PATH で変えられる
 *
 * @param env - 環境変数
 * @param run - CLIを実行する処理(テストで差し替える)
 * @returns 選定を依頼する処理
 * @throws {ConfigError} AI_BOX_TIMEOUT が正の数でない場合
 */
export function createClaudeCliBoxSelectorFromEnvironment(env: Environment, run?: CliRunner): BoxSelector {
    const model = env.AI_BOX_MODEL;
    const command = env.CLAUDE_CLI_PATH;
    const timeoutSeconds = readNumberEnv(env, "AI_BOX_TIMEOUT", DEFAULT_TIMEOUT_SECONDS);
    if (timeoutSeconds <= 0) {
        throw new ConfigError(`AI_BOX_TIMEOUT must be greater than 0: ${timeoutSeconds}`);
    }
    return createClaudeCliBoxSelector({
        env,
        run,
        model: model == null || model === "" ? undefined : model,
        command: command == null || command === "" ? undefined : command,
        timeoutSeconds,
    });
}
