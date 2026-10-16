//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

// db.netkeiba.com のレース結果ページ(race/<id>/)を解析する純関数群
// DBには触れず 解析結果のレコードを返す 構造が想定と異なる場合は ParseError を投げる

import { type CheerioAPI, load } from "cheerio";

import type {
    HorseRecord,
    JockeyRecord,
    OwnerRecord,
    PayoffRecord,
    RaceInfoRecord,
    RaceResultRecord,
    TrainerRecord,
} from "../db/schema.ts";
import { raceClassToInt, ticketTypeToInt } from "../util.ts";
import {
    ParseError,
    padTwoDigits,
    parsePyFloat,
    parsePyInt,
    pyStrip,
    requirePyFloat,
    requirePyInt,
    secondLastPathSegment,
} from "./py-compat.ts";
import { pyqueryText } from "./pyquery-text.ts";

// 開催日の行に混じる改行不可スペース(U+00A0)
const NO_BREAK_SPACE = String.fromCharCode(0xa0);

// Pythonの \w は日本語を含む英数字全般に一致するため Unicode のプロパティで表す
const WORD = "[\\p{L}\\p{N}_]";

const RACE_DATA_PATTERN = new RegExp(
    `^([^\\d ]+).*?(\\d{4})m\\s*/\\s*天候 : (${WORD}+)\\s*/\\s*(.+)\\s+/\\s+発走 : (\\d{1,2}:\\d{1,2})`,
    "u",
);
const TRACK_CONDITION_PATTERN = new RegExp(`^.*?\\s*:\\s*(${WORD}+)\\s*`, "u");
const RACE_DATE_PATTERN = /^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(\S+?)(?:\s+(.+))?$/u;
const SEX_AGE_PATTERN = /^(.)(\d+)$/u;
const FINISHING_TIME_PATTERN = /^(\d+):(\d+)\.(\d+)$/;
const HORSE_WEIGHT_PATTERN = /^(\d+)\(\+?(-?\d+)\)$/;
const STABLE_PATTERN = /^\[(.)\]/u;
const BREAK_PATTERN = /<br\s*\/?>/i;

// 結果表の見出し文字列(空白を除いたもの)と項目の対応 列の位置はサイトの改修で変わるため位置では決めない
// 旧形式は21列 現行は25列(指数系の列が増えた) 増えた列は読まないので対応表に載せない
const RESULT_COLUMN_PATTERNS = {
    orderOfFinish: /^着順$/,
    bracketNumber: /^枠番$/,
    horseNumber: /^馬番$/,
    horse: /^馬名$/,
    sexAge: /^性齢$/,
    basisWeight: /^斤量$/,
    jockey: /^騎手$/,
    finishingTime: /^タイム$/,
    margin: /^着差$/,
    // 現行は「ﾀｲﾑ指数」の後ろに説明文が続き 直後に「ﾀｲﾑ指数M」の列がある プレミアム会員向けで値は「**」
    speedFigure: /^ﾀｲﾑ指数(?!M)/,
    passingRank: /^通過$/,
    lastPhase: /^上り$/,
    odds: /^単勝$/,
    popularity: /^人気$/,
    horseWeight: /^馬体重$/,
    remark: /^備考$/,
    trainer: /^調教師$/,
    owner: /^馬主$/,
    earningMoney: /^賞金/,
} as const;

type ResultColumn = keyof typeof RESULT_COLUMN_PATTERNS;

// 無くても解析を続ける列 プレミアム会員向けでサイトの都合で消える可能性がある
const OPTIONAL_RESULT_COLUMNS: ReadonlySet<ResultColumn> = new Set(["speedFigure"]);

/** 結果表の項目ごとの列番号 */
type ResultColumnIndexes = ReadonlyMap<ResultColumn, number>;

/**
 * 結果表の見出しから 項目ごとの列番号を決める
 *
 * @param headers - 見出し行の各セルの文字列
 * @returns 項目ごとの列番号 見つからなかった任意の項目は含まない
 * @throws {ParseError} 必須の項目の見出しが見つからない場合
 */
export function resolveResultColumns(headers: readonly string[]): ResultColumnIndexes {
    const normalized = headers.map((header) => header.replace(/\s+/g, ""));
    const indexes = new Map<ResultColumn, number>();
    const missing: ResultColumn[] = [];

    for (const [column, pattern] of Object.entries(RESULT_COLUMN_PATTERNS) as Array<[ResultColumn, RegExp]>) {
        const index = normalized.findIndex((header) => pattern.test(header));
        if (index >= 0) {
            indexes.set(column, index);
        } else if (!OPTIONAL_RESULT_COLUMNS.has(column)) {
            missing.push(column);
        }
    }
    if (missing.length > 0) {
        throw new ParseError(`result table columns not found: ${missing.join(", ")}`);
    }
    return indexes;
}

/** レース結果ページから抽出した出走馬ごとの記録 */
export type RaceResultSet = {
    horses: HorseRecord[];
    jockeys: JockeyRecord[];
    trainers: TrainerRecord[];
    owners: OwnerRecord[];
    results: RaceResultRecord[];
};

/**
 * レース結果ページのHTMLを解析用のDOMへ変換する
 *
 * @param html - レース結果ページのHTML
 * @returns cheerioのAPI
 */
export function loadRaceDocument(html: string): CheerioAPI {
    return load(html);
}

/**
 * レース名や距離など レース全体の情報を抽出する
 *
 * @param raceId - レースID
 * @param $ - レース結果ページのDOM
 * @returns レース情報のレコード
 * @throws {ParseError} レース番号の変換や必須項目の抽出に失敗した場合
 */
export function parseRaceInfo(raceId: number, $: CheerioAPI): RaceInfoRecord {
    const raceHead = $("html body div#page div#main div.race_head");

    const raceNumberText = pyqueryText(raceHead.find("dl.racedata dt"));
    // 表記は「1 R」から「1R」に変わった サイトの変更に合わせ 先頭の語の末尾にある R を取り除いてから数値にする
    const raceNumberToken = (raceNumberText.split(" ")[0] ?? "").replace(/R$/, "");
    const raceNumber = raceNumberText === "" ? null : requirePyInt(raceNumberToken, "race number");

    const raceName = pyqueryText(raceHead.find("dl.racedata dd h1"));

    let distance: number | null = null;
    let weather: string | null = null;
    let postTime: string | null = null;
    let trackSurface: string | null = null;
    let trackCondition: string | null = null;
    let runDirection: string | null = null;

    // 路面 距離 天候 馬場状態 発走時刻
    const raceInfoText = pyqueryText(raceHead.find("dl.racedata dd p span"));
    const raceInfoMatch = RACE_DATA_PATTERN.exec(raceInfoText);
    if (raceInfoMatch) {
        const surfaceOriginal = raceInfoMatch[1] ?? "";
        if (surfaceOriginal.startsWith("芝")) {
            trackSurface = "芝";
        } else if (surfaceOriginal.startsWith("ダ")) {
            trackSurface = "ダート";
        } else if (surfaceOriginal.startsWith("障")) {
            trackSurface = "障害";
        }

        if (surfaceOriginal.includes("左")) {
            runDirection = "左";
        } else if (surfaceOriginal.includes("右")) {
            runDirection = "右";
        } else if (surfaceOriginal.includes("直線")) {
            runDirection = "直線";
        }
        if (runDirection != null && surfaceOriginal.endsWith("外")) {
            runDirection = `${runDirection} 外`;
        }

        distance = requirePyInt(raceInfoMatch[2] ?? "", "distance");
        weather = raceInfoMatch[3] ?? null;

        const conditionMatch = TRACK_CONDITION_PATTERN.exec(raceInfoMatch[4] ?? "");
        if (conditionMatch) {
            trackCondition = conditionMatch[1] ?? null;
        }

        const [hour = "", minute = ""] = (raceInfoMatch[5] ?? "").split(":");
        postTime = `${padTwoDigits(hour)}:${padTwoDigits(minute)}`;
    }

    // 開催日 開催場所 クラス
    const dateText = pyStrip(pyqueryText(raceHead.find("div.mainrace_data p").eq(1)).replaceAll(NO_BREAK_SPACE, " "));
    const dateMatch = RACE_DATE_PATTERN.exec(dateText);
    let raceDate: string | null = null;
    let placeDetail: string | null = null;
    let raceClass: string | null = null;
    if (dateMatch) {
        raceDate = `${dateMatch[1]}-${padTwoDigits(dateMatch[2] ?? "")}-${padTwoDigits(dateMatch[3] ?? "")}`;
        placeDetail = dateMatch[4] ?? null;
        raceClass = dateMatch[5] ?? null;
    }

    if (raceNumber == null || raceDate == null || placeDetail == null) {
        throw new ParseError(`race info is incomplete: race_id=${raceId}`);
    }

    return {
        id: raceId,
        raceName,
        distance,
        weather,
        postTime,
        raceNumber,
        runDirection,
        trackSurface,
        trackCondition,
        trackConditionScore: null,
        date: raceDate,
        placeDetail,
        raceGrade: raceClassToInt(raceClass),
        raceClass,
    };
}

// 着順表の「1:23.4」を DB の time 型へ渡せる「00:01:23.4」へ整える
function formatFinishingTime(minutes: string, seconds: string, fraction: string): string {
    return `00:${padTwoDigits(minutes)}:${padTwoDigits(seconds)}.${fraction}`;
}

/**
 * 着順表から馬 騎手 調教師 馬主 レース結果の各記録を抽出する
 *
 * 列は見出しの文字列で決める 表が無い場合は空の結果を返す
 *
 * @param raceId - レースID
 * @param $ - レース結果ページのDOM
 * @returns 出走馬ごとの記録
 * @throws {ParseError} 必須の列が無い場合 行の列数が見出しと違う場合 馬番や馬IDなど必須の値が数値へ変換できない場合
 */
export function parseRaceResults(raceId: number, $: CheerioAPI): RaceResultSet {
    const set: RaceResultSet = { horses: [], jockeys: [], trainers: [], owners: [], results: [] };

    const rows = $("html body div#page div#contents_liquid table.race_table_01 tr").toArray();
    const headerRow = rows.find((row) => $(row).find("th").length > 0);
    if (headerRow == null) {
        return set;
    }
    const headers = $(headerRow)
        .find("th")
        .toArray()
        .map((header) => pyqueryText($(header)));
    const indexes = resolveResultColumns(headers);

    for (const row of rows) {
        const columns = $(row).find("td");
        if (columns.length === 0) {
            // 見出し行など値を持たない行
            continue;
        }
        if (columns.length !== headers.length) {
            throw new ParseError(
                `result row has ${columns.length} columns, expected ${headers.length}: race_id=${raceId}`,
            );
        }

        // 見出しの検証で必須の項目は存在する 任意の項目が無い場合は空文字列を返す
        const cell = (column: ResultColumn) => {
            const index = indexes.get(column);
            return index == null ? columns.slice(0, 0) : columns.eq(index);
        };
        const text = (column: ResultColumn): string => pyqueryText(cell(column));
        const link = (column: ResultColumn) => cell(column).find("a").eq(0);

        const orderOfFinish = parsePyInt(text("orderOfFinish"));
        const bracketNumber = requirePyInt(text("bracketNumber"), "bracket number");
        const horseNumber = requirePyInt(text("horseNumber"), "horse number");

        const horseId = requirePyInt(secondLastPathSegment(link("horse").attr("href")), "horse id");
        const horseName = pyqueryText(link("horse"));

        let sex: string | null = null;
        let age = 0;
        const sexAgeMatch = SEX_AGE_PATTERN.exec(text("sexAge"));
        if (sexAgeMatch) {
            sex = sexAgeMatch[1] ?? null;
            age = requirePyInt(sexAgeMatch[2] ?? "", "age");
        }
        if (sex == null) {
            throw new ParseError(`sex is missing: race_id=${raceId}, horse_number=${horseNumber}`);
        }

        const basisWeight = requirePyFloat(text("basisWeight"), "basis weight");

        const jockeyId = secondLastPathSegment(link("jockey").attr("href"));
        const jockeyName = pyqueryText(link("jockey"));

        let finishingTime: string | null = null;
        const timeMatch = FINISHING_TIME_PATTERN.exec(text("finishingTime"));
        if (timeMatch) {
            finishingTime = formatFinishingTime(timeMatch[1] ?? "", timeMatch[2] ?? "", timeMatch[3] ?? "");
        }

        let horseWeight: number | null = null;
        let horseWeightDiff: number | null = null;
        const weightMatch = HORSE_WEIGHT_PATTERN.exec(text("horseWeight"));
        if (weightMatch) {
            horseWeight = requirePyInt(weightMatch[1] ?? "", "horse weight");
            horseWeightDiff = requirePyInt(weightMatch[2] ?? "", "horse weight diff");
        }

        const remarkText = text("remark");

        let stable = "不明";
        const stableMatch = STABLE_PATTERN.exec(text("trainer"));
        if (stableMatch) {
            stable = stableMatch[1] ?? stable;
        }

        const trainerId = secondLastPathSegment(link("trainer").attr("href"));
        const trainerName = pyqueryText(link("trainer"));

        const ownerId = secondLastPathSegment(link("owner").attr("href"));
        const ownerName = pyqueryText(link("owner"));

        set.horses.push({ id: horseId, horseName });
        set.jockeys.push({ id: jockeyId, jockeyName });
        set.trainers.push({ id: trainerId, trainerName });
        set.owners.push({ id: ownerId, ownerName });
        set.results.push({
            raceId,
            horseNumber,
            orderOfFinish,
            bracketNumber,
            horseId,
            sex,
            age,
            basisWeight,
            jockeyId,
            finishingTime,
            margin: text("margin"),
            speedFigure: parsePyInt(text("speedFigure")),
            passingRank: text("passingRank"),
            lastPhase: parsePyFloat(text("lastPhase")),
            odds: parsePyFloat(text("odds")),
            popularity: parsePyInt(text("popularity")),
            horseWeight,
            horseWeightDiff,
            remark: remarkText === "" ? null : remarkText,
            stable,
            trainerId,
            ownerId,
            earningMoney: parsePyFloat(text("earningMoney").replaceAll(",", "")) ?? 0,
        });
    }

    return set;
}

/**
 * 払戻表から券種ごとの払戻を抽出する
 *
 * 複勝やワイドのように1つのセルへ複数の払戻が改行(br)で並ぶ場合は行ごとに展開する
 *
 * @param raceId - レースID
 * @param $ - レース結果ページのDOM
 * @param onUnknownTicketType - 未知の券種を読み飛ばすときに呼ばれる関数
 * @returns 払戻のレコード
 * @throws {ParseError} 払戻や人気が数値へ変換できない場合
 */
export function parsePayoffs(
    raceId: number,
    $: CheerioAPI,
    onUnknownTicketType: (label: string) => void,
): PayoffRecord[] {
    const payoffs: PayoffRecord[] = [];

    for (const row of $("html body div#page div#contents dl.pay_block tr").toArray()) {
        const label = pyqueryText($(row).find("th").eq(0));
        const ticketType = ticketTypeToInt(label);
        if (ticketType == null) {
            onUnknownTicketType(label);
            continue;
        }

        const columns = $(row).find("td");
        const horseNumbersList = (columns.eq(0).html() ?? "None").split(BREAK_PATTERN);
        const payoffList = (columns.eq(1).html() ?? "None").split(BREAK_PATTERN);
        const popularityList = (columns.eq(2).html() ?? "None").split(BREAK_PATTERN);

        horseNumbersList.forEach((horseNumbers, index) => {
            payoffs.push({
                raceId,
                ticketType,
                horseNumbers: horseNumbers.replaceAll(" ", "").replaceAll("→", "->"),
                payoff: requirePyInt((payoffList[index] ?? "").replaceAll(",", ""), "payoff"),
                popularity: requirePyInt(popularityList[index] ?? "", "popularity"),
            });
        });
    }

    return payoffs;
}
