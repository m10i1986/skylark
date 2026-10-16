//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { parseArgs } from "node:util";

/** コマンドライン引数の内容 */
export type CliArguments = {
    // HTMLキャッシュなどを置くディレクトリ
    temp: string;
    raceListFile: string;
    periodOfMonths: number;
    isRebuildAllTables: boolean;
    isRebuildFeature: boolean;
    isUpdateRaceList: boolean;
    isScraping: boolean;
    isFeature: boolean;
    isDebug: boolean;
    isHelp: boolean;
    raceIds: string[];
};

/** コマンドライン引数が不正であることを表す */
export class CliUsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CliUsageError";
    }
}

/** ヘルプ表示用の文章 */
export const USAGE = `usage: cli.ts [-h] [--temp TEMP] [--race-list-file RACE_LIST_FILE]
              [--period-of-months PERIOD_OF_MONTHS] [--rebuild-all-tables]
              [-Rf] [-U] [-S] [-F] [--debug]
              [race_id ...]

This script is a program that netkeiba.com scraping.

positional arguments:
  race_id               Race ID

options:
  -h, --help            show this help message and exit
  --temp TEMP           temp directory(default: ./temp/)
  --race-list-file RACE_LIST_FILE
                        race list file(default: race_list.txt)
  --period-of-months PERIOD_OF_MONTHS
                        period of months(default: 12)
  --rebuild-all-tables  Rebuild all tables(default: False)
  -Rf, --rebuild-feature
                        Rebuild feature table(default: False)
  -U, --update-race-list
                        Update race list(default: False)
  -S, --scraping        scraping mode(default: False)
  -F, --feature         feature mode(default: False)
  --debug               Debug mode(default: False)
`;

// node:util の parseArgs は2文字以上の短いオプションを扱えないため 長いオプションへ置き換える
const SHORT_ALIASES: Readonly<Record<string, string>> = {
    "-Rf": "--rebuild-feature",
};

/**
 * コマンドライン引数を解析する
 *
 * @param argv - 実行ファイル名を除いた引数
 * @returns 解析結果
 * @throws {CliUsageError} 未知のオプションや不正な値の場合
 */
export function parseCliArguments(argv: readonly string[]): CliArguments {
    const normalized = argv.map((argument) => SHORT_ALIASES[argument] ?? argument);

    let parsed: ReturnType<typeof parseWithSchema>;
    try {
        parsed = parseWithSchema(normalized);
    } catch (error) {
        throw new CliUsageError(error instanceof Error ? error.message : String(error));
    }
    const { values, positionals } = parsed;

    const periodText = values["period-of-months"];
    if (!/^[+-]?\d+$/.test(periodText.trim())) {
        throw new CliUsageError(`argument --period-of-months: invalid int value: '${periodText}'`);
    }

    return {
        temp: values.temp,
        raceListFile: values["race-list-file"],
        periodOfMonths: Number(periodText.trim()),
        isRebuildAllTables: values["rebuild-all-tables"],
        isRebuildFeature: values["rebuild-feature"],
        isUpdateRaceList: values["update-race-list"],
        isScraping: values.scraping,
        isFeature: values.feature,
        isDebug: values.debug,
        isHelp: values.help,
        raceIds: positionals,
    };
}

function parseWithSchema(args: string[]) {
    return parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: {
            temp: { type: "string", default: "./temp" },
            "race-list-file": { type: "string", default: "race_list.txt" },
            "period-of-months": { type: "string", default: "12" },
            "rebuild-all-tables": { type: "boolean", default: false },
            "rebuild-feature": { type: "boolean", default: false },
            "update-race-list": { type: "boolean", short: "U", default: false },
            scraping: { type: "boolean", short: "S", default: false },
            feature: { type: "boolean", short: "F", default: false },
            debug: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
        },
    });
}
