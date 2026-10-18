//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import type { CliArguments } from "./cli-args.ts";
import { CliUsageError, parseCliArguments, USAGE } from "./cli-args.ts";
import { createLogger } from "./logger.ts";
import { runOperations } from "./operations.ts";

/**
 * コマンドラインのエントリーポイント
 *
 * 失敗はログへ記録し 終了コードで通知する
 *
 * @param argv - 実行ファイル名を除いた引数
 * @returns 終了コード 0=正常 1=処理失敗 2=引数不正
 */
export async function main(argv: readonly string[]): Promise<number> {
    let args: CliArguments;
    try {
        args = parseCliArguments(argv);
    } catch (error) {
        if (error instanceof CliUsageError) {
            process.stderr.write(`${USAGE}\ncli.ts: error: ${error.message}\n`);
            return 2;
        }
        throw error;
    }

    if (args.isHelp) {
        process.stdout.write(USAGE);
        return 0;
    }

    const logger = createLogger(args.isDebug ? "debug" : "info");
    try {
        await runOperations(args, {
            logger,
            output: (text) => {
                process.stdout.write(text);
            },
            env: process.env,
        });
        return 0;
    } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error), error);
        return 1;
    }
}

if (import.meta.main) {
    process.exitCode = await main(Bun.argv.slice(2));
}
