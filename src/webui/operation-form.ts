//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

// 操作画面のフォームの値を CLI と同じ CliArguments に変換する
// 値は一度コマンドライン引数の形に組み立て parseCliArguments() で検証する 検証の規則をコマンドラインと共有するため

import {
    type CliArguments,
    CliUsageError,
    DEFAULT_HISTORY_SINCE,
    DEFAULT_PERIOD_OF_MONTHS,
    DEFAULT_RACE_LIST_FILE,
    parseCliArguments,
} from "../cli-args.ts";
import { DEFAULT_VALUE_CRITERIA } from "../predict/value.ts";
import {
    FLAG_FIELDS,
    FLAG_ON,
    type FlagField,
    MAX_FIELD_CHARS,
    MAX_PERIOD_MONTHS,
    MAX_RACE_IDS,
    MAX_RACE_IDS_CHARS,
    MIN_PERIOD_MONTHS,
    type OperationDefaults,
    type OperationFormValues,
    TEXT_FIELDS,
    type TextField,
} from "./operation-fields.ts";

// 英数字と . _ - だけの名前 フォルダの区切りや「..」を含められない
const RACE_LIST_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RACE_ID_PATTERN = /^\d{1,18}$/;
const PERIOD_PATTERN = /^\d{1,3}$/;

// 値をそのまま --名前=値 の形で渡す入力欄(検証は parseCliArguments が行う)
const PASS_THROUGH_OPTIONS: ReadonlyArray<{ field: TextField; option: string }> = [
    { field: "date", option: "--date" },
    { field: "historySince", option: "--history-since" },
    { field: "minOdds", option: "--min-odds" },
    { field: "minPopularity", option: "--min-popularity" },
    { field: "maxRank", option: "--max-rank" },
    { field: "minEv", option: "--min-ev" },
];

// 実行する順(operations.ts の実行順と同じ)
const ACTIONS: ReadonlyArray<{ field: FlagField; option: string; label: string }> = [
    { field: "rebuildAllTables", option: "--rebuild-all-tables", label: "全テーブルの削除" },
    { field: "rebuildFeature", option: "--rebuild-feature", label: "特徴量テーブルの再構築" },
    { field: "updateRaceList", option: "--update-race-list", label: "レース一覧の更新" },
    { field: "scraping", option: "--scraping", label: "ダウンロードと保存" },
    { field: "feature", option: "--feature", label: "特徴量の計算" },
    { field: "train", option: "--train", label: "学習" },
    { field: "predict", option: "--predict", label: "予測と抽出" },
    { field: "report", option: "--report", label: "結果の突き合わせ" },
];

/** 検証を通った操作 */
export type ParsedOperation = {
    args: CliArguments;
    // ジョブの題名
    title: string;
    // 同じ内容をコマンドラインで実行する場合の引数
    commandLine: string;
};

export type ParseOperationResult = { ok: true; operation: ParsedOperation } | { ok: false; errors: string[] };

/**
 * 画面の入力欄の初期値(コマンドラインの既定値)を作る
 *
 * @param tempDirectory - HTMLキャッシュの置き場
 * @returns 既定値
 */
export function buildOperationDefaults(tempDirectory: string): OperationDefaults {
    return {
        periodOfMonths: DEFAULT_PERIOD_OF_MONTHS,
        raceListFile: DEFAULT_RACE_LIST_FILE,
        historySince: DEFAULT_HISTORY_SINCE,
        minOdds: DEFAULT_VALUE_CRITERIA.minOdds,
        minPopularity: DEFAULT_VALUE_CRITERIA.minPopularity,
        maxRank: DEFAULT_VALUE_CRITERIA.maxModelRank,
        minExpectedValue: DEFAULT_VALUE_CRITERIA.minExpectedValue,
        tempDirectory,
    };
}

/**
 * 送信されたフォームから 既知の項目の文字列だけを取り出す
 *
 * 知らない項目と文字列でない値(ファイルなど)は捨てる 長すぎる値は上限を少し超える長さで切る(検証で拒否される)
 *
 * @param form - 送信されたフォーム
 * @returns フォームの値
 */
export function collectFormValues(form: Readonly<Record<string, unknown>>): OperationFormValues {
    const values: OperationFormValues = {};
    // 継承したプロパティは読まない(送信された項目だけを対象にする)
    const own = (field: string): unknown => (Object.hasOwn(form, field) ? form[field] : undefined);
    for (const field of FLAG_FIELDS) {
        if (own(field) === FLAG_ON) {
            values[field] = FLAG_ON;
        }
    }
    for (const field of TEXT_FIELDS) {
        const raw = own(field);
        if (typeof raw === "string") {
            const limit = field === "raceIds" ? MAX_RACE_IDS_CHARS : MAX_FIELD_CHARS;
            values[field] = raw.slice(0, limit + 1);
        }
    }
    return values;
}

// 空白かカンマで区切ったレースIDを取り出す
function splitRaceIds(text: string): string[] {
    return text.split(/[\s,]+/).filter((token) => token !== "");
}

/**
 * フォームの値を検証して CLI と同じ引数に変換する
 *
 * HTMLキャッシュの置き場(--temp)は画面から指定できない 呼び出し側が決める
 *
 * @param values - フォームの値
 * @returns 検証を通った操作 または利用者へ見せるエラー
 */
export function parseOperationForm(values: OperationFormValues): ParseOperationResult {
    const errors: string[] = [];
    const isOn = (field: FlagField): boolean => values[field] === FLAG_ON;
    const textOf = (field: TextField): string => (values[field] ?? "").trim();

    const argv: string[] = [];
    const labels: string[] = [];
    for (const action of ACTIONS) {
        if (!isOn(action.field)) {
            continue;
        }
        argv.push(action.option);
        labels.push(action.label);
    }
    if (argv.length === 0) {
        errors.push("実行する処理を1つ以上選んでください。");
    }
    // 取り返しのつかない操作は確認欄のチェックを必須にする(画面だけでなくサーバーでも確かめる)
    if (isOn("rebuildAllTables") && !isOn("confirmRebuildAllTables")) {
        errors.push("全テーブルを削除するには、確認欄にチェックしてください。");
    }
    if (isOn("rebuildFeature") && !isOn("confirmRebuildFeature")) {
        errors.push("特徴量テーブルを再構築するには、確認欄にチェックしてください。");
    }
    if (isOn("verbose")) {
        argv.push("--verbose");
    }
    if (isOn("debug")) {
        argv.push("--debug");
    }

    const period = textOf("periodOfMonths");
    if (period !== "") {
        const months = Number(period);
        if (!PERIOD_PATTERN.test(period) || months < MIN_PERIOD_MONTHS || months > MAX_PERIOD_MONTHS) {
            errors.push(`遡る月数は ${MIN_PERIOD_MONTHS} 〜 ${MAX_PERIOD_MONTHS} の整数で指定してください。`);
        } else {
            argv.push(`--period-of-months=${period}`);
        }
    }

    const raceListFile = textOf("raceListFile");
    if (raceListFile !== "") {
        if (RACE_LIST_FILE_PATTERN.test(raceListFile)) {
            argv.push(`--race-list-file=${raceListFile}`);
        } else {
            errors.push(
                "レース一覧のファイル名は、英数字と . _ - だけで 64 文字以内にしてください(フォルダは指定できません)。",
            );
        }
    }

    for (const { field, option } of PASS_THROUGH_OPTIONS) {
        const value = textOf(field);
        if (value === "") {
            continue;
        }
        if (value.length > MAX_FIELD_CHARS) {
            errors.push(`${option} の値が長すぎます。`);
        } else {
            argv.push(`${option}=${value}`);
        }
    }

    const rawRaceIds = values.raceIds ?? "";
    const raceIds = rawRaceIds.length > MAX_RACE_IDS_CHARS ? [] : splitRaceIds(rawRaceIds);
    if (rawRaceIds.length > MAX_RACE_IDS_CHARS || raceIds.length > MAX_RACE_IDS) {
        errors.push(`レース ID は ${MAX_RACE_IDS} 件までです。`);
    } else {
        const invalid = raceIds.find((raceId) => !RACE_ID_PATTERN.test(raceId));
        if (invalid != null) {
            errors.push(`レース ID は数字だけで指定してください: ${invalid.slice(0, 20)}`);
        } else if (raceIds.length > 0 && !isOn("scraping") && !isOn("predict")) {
            errors.push("レース ID は、ダウンロード(-S)か予測(-P)と一緒に指定してください。");
        } else if (raceIds.length > 0) {
            // 「--」の後ろは すべて位置引数として扱われる(「-」で始まる値がオプションに解釈されない)
            argv.push("--", ...raceIds);
        }
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    try {
        const args = parseCliArguments(argv);
        return { ok: true, operation: { args, title: labels.join(" → "), commandLine: argv.join(" ") } };
    } catch (error) {
        if (error instanceof CliUsageError) {
            return { ok: false, errors: [error.message] };
        }
        throw error;
    }
}
