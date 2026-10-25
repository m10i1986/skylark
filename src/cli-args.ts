//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { parseArgs } from "node:util";

import { boxTicketCount, DEFAULT_BOX_MAX_TICKETS, MAX_BOX_HORSES, MIN_BOX_HORSES } from "./predict/trifecta.ts";
import { DEFAULT_VALUE_CRITERIA, type ValueCriteria } from "./predict/value.ts";

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
    isTrain: boolean;
    isPredict: boolean;
    isAiBox: boolean;
    isReport: boolean;
    isVerbose: boolean;
    isDebug: boolean;
    isHelp: boolean;
    // 結果の突き合わせ(--report)の開催日(YYYY-MM-DD) 省略時は今日
    date: string | null;
    // 学習と予測で履歴に使う最初の開催日(YYYY-MM-DD)
    historySince: string;
    // 「勝率が高いのに人気がない馬」の抽出条件
    valueCriteria: ValueCriteria;
    // 3連単Boxの点数の上限(-B) 頭数を指定した場合(boxHorses)は その頭数のBoxの点数
    boxMaxTickets: number;
    // 3連単Boxの頭数(-B) 指定するとその頭数ちょうどのBoxにする nullならAIが点数の上限内で頭数も選ぶ
    boxHorses: number | null;
    raceIds: string[];
};

/** 学習と予測で履歴に使う最初の開催日の既定値 DBの2016年分は2017〜2024年と離れているため使わない */
export const DEFAULT_HISTORY_SINCE = "2025-01-01";

/** HTMLキャッシュを置くディレクトリの既定値 */
export const DEFAULT_TEMP_DIRECTORY = "./temp";

/** レース一覧のファイル名の既定値 */
export const DEFAULT_RACE_LIST_FILE = "race_list.txt";

/** 一覧を遡る月数の既定値 */
export const DEFAULT_PERIOD_OF_MONTHS = 12;

/** 一度に3連単Boxを提案できるレース数の上限 レースごとにClaude CLIを呼び 時間と利用枠を使うため */
export const MAX_AI_BOX_RACES = 12;

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
              [-Rf] [-U] [-S] [-F] [-T] [-P] [-B] [--report] [--date DATE]
              [--history-since DATE] [--min-odds N] [--min-popularity N]
              [--max-rank N] [--min-ev N] [--box-max-tickets N | --box-horses N]
              [--verbose] [--debug]
              [race_id ...]

This script is a program that netkeiba.com scraping.

positional arguments:
  race_id               Race ID (with -S: races to download, with -P/-B: races to predict;
                        -B requires at least one race_id and accepts up to 12)

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
  -T, --train           train the win probability model and save it to the DB(default: False)
  -P, --predict         predict today's central races and extract horses whose
                        win probability is high but popularity is low(default: False)
  -B, --ai-box          ask Claude to pick a trifecta box for the given races (predicts them first;
                        runs the claude CLI per race, so it must be logged in)(default: False)
  --report              compare saved predictions with the results of --date(default: False)
  --date DATE           date for --report, YYYY-MM-DD(default: today)
  --history-since DATE  first date of the past results used by -T and -P(default: 2025-01-01)
  --min-odds N          pick: win odds at least N(default: 10)
  --min-popularity N    pick: popularity rank N or lower, a larger number is less popular(default: 4)
  --max-rank N          pick: model win probability rank N or higher(default: 5)
  --min-ev N            pick: expected value (win probability x odds) at least N, 0 disables(default: 1)
  --box-max-tickets N   -B: upper limit of tickets of the box, 6 to 336 (3 to 8 horses); the AI also picks
                        the number of horses within it(default: 60)
  --box-horses N        -B: make the box of exactly N horses, 3 to 8; the AI only picks which horses
                        (cannot be used with --box-max-tickets)
  --verbose             show every runner of every race with -P(default: False)
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

    const valueCriteria: ValueCriteria = {
        minOdds: parseNumberOption("--min-odds", values["min-odds"], 1),
        minPopularity: parseIntegerOption("--min-popularity", values["min-popularity"], 1),
        maxModelRank: parseIntegerOption("--max-rank", values["max-rank"], 1),
        minExpectedValue: parseNumberOption("--min-ev", values["min-ev"], 0),
    };
    const date = values.date == null ? null : parseDateOption("--date", values.date);
    const boxHorses = values["box-horses"] == null ? null : parseBoxHorses(values["box-horses"]);
    if (boxHorses != null && values["box-max-tickets"] != null) {
        throw new CliUsageError("argument --box-horses: not allowed with argument --box-max-tickets");
    }
    // 頭数を指定した場合の点数の上限は その頭数のBoxの点数
    const boxMaxTickets =
        boxHorses == null
            ? parseBoxMaxTickets(values["box-max-tickets"] ?? String(DEFAULT_BOX_MAX_TICKETS))
            : boxTicketCount(boxHorses);
    if (values["ai-box"] && (positionals.length < 1 || positionals.length > MAX_AI_BOX_RACES)) {
        throw new CliUsageError(
            `argument -B: specify 1 to ${MAX_AI_BOX_RACES} race ids (each race runs the Claude CLI)`,
        );
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
        isTrain: values.train,
        isPredict: values.predict,
        isAiBox: values["ai-box"],
        isReport: values.report,
        isVerbose: values.verbose,
        isDebug: values.debug,
        isHelp: values.help,
        date,
        historySince: parseDateOption("--history-since", values["history-since"]),
        valueCriteria,
        boxMaxTickets,
        boxHorses,
        raceIds: positionals,
    };
}

// 3頭から8頭までの頭数
function parseBoxHorses(text: string): number {
    const trimmed = text.trim();
    if (!/^\d$/.test(trimmed) || Number(trimmed) < MIN_BOX_HORSES || Number(trimmed) > MAX_BOX_HORSES) {
        throw new CliUsageError(
            `argument --box-horses: must be an integer from ${MIN_BOX_HORSES} to ${MAX_BOX_HORSES}: '${text}'`,
        );
    }
    return Number(trimmed);
}

// 3頭(6点)から8頭(336点)までの点数
function parseBoxMaxTickets(text: string): number {
    const minimum = boxTicketCount(MIN_BOX_HORSES);
    const maximum = boxTicketCount(MAX_BOX_HORSES);
    if (!/^\d{1,4}$/.test(text.trim()) || Number(text.trim()) < minimum || Number(text.trim()) > maximum) {
        throw new CliUsageError(
            `argument --box-max-tickets: must be an integer from ${minimum} to ${maximum}: '${text}'`,
        );
    }
    return Number(text.trim());
}

function parseNumberOption(name: string, text: string, minimum: number): number {
    const value = Number(text.trim());
    if (text.trim() === "" || !Number.isFinite(value) || value < minimum) {
        throw new CliUsageError(`argument ${name}: must be a number of at least ${minimum}: '${text}'`);
    }
    return value;
}

function parseIntegerOption(name: string, text: string, minimum: number): number {
    if (!/^\d{1,6}$/.test(text.trim()) || Number(text.trim()) < minimum) {
        throw new CliUsageError(`argument ${name}: must be an integer of at least ${minimum}: '${text}'`);
    }
    return Number(text.trim());
}

// 「2026-02-30」のように存在しない日付も拒否する
function parseDateOption(name: string, text: string): string {
    const isRealDate =
        /^\d{4}-\d{2}-\d{2}$/.test(text) && new Date(Date.parse(text)).toISOString().slice(0, 10) === text;
    if (!isRealDate) {
        throw new CliUsageError(`argument ${name}: must be a date like 2026-01-31: '${text}'`);
    }
    return text;
}

function parseWithSchema(args: string[]) {
    return parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: {
            temp: { type: "string", default: DEFAULT_TEMP_DIRECTORY },
            "race-list-file": { type: "string", default: DEFAULT_RACE_LIST_FILE },
            "period-of-months": { type: "string", default: String(DEFAULT_PERIOD_OF_MONTHS) },
            "rebuild-all-tables": { type: "boolean", default: false },
            "rebuild-feature": { type: "boolean", default: false },
            "update-race-list": { type: "boolean", short: "U", default: false },
            scraping: { type: "boolean", short: "S", default: false },
            feature: { type: "boolean", short: "F", default: false },
            train: { type: "boolean", short: "T", default: false },
            predict: { type: "boolean", short: "P", default: false },
            "ai-box": { type: "boolean", short: "B", default: false },
            report: { type: "boolean", default: false },
            verbose: { type: "boolean", default: false },
            date: { type: "string" },
            "history-since": { type: "string", default: DEFAULT_HISTORY_SINCE },
            "min-odds": { type: "string", default: String(DEFAULT_VALUE_CRITERIA.minOdds) },
            "min-popularity": { type: "string", default: String(DEFAULT_VALUE_CRITERIA.minPopularity) },
            "max-rank": { type: "string", default: String(DEFAULT_VALUE_CRITERIA.maxModelRank) },
            "min-ev": { type: "string", default: String(DEFAULT_VALUE_CRITERIA.minExpectedValue) },
            "box-max-tickets": { type: "string" },
            "box-horses": { type: "string" },
            debug: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
        },
    });
}
