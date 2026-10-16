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
 * @param raceId - レースID
 * @param $ - レース結果ページのDOM
 * @returns 出走馬ごとの記録
 * @throws {ParseError} 馬番や馬IDなど必須の値が数値へ変換できない場合
 */
export function parseRaceResults(raceId: number, $: CheerioAPI): RaceResultSet {
    const set: RaceResultSet = { horses: [], jockeys: [], trainers: [], owners: [], results: [] };

    // 先頭行は見出し
    const rows = $("html body div#page div#contents_liquid table tr").toArray().slice(1);
    for (const row of rows) {
        const columns = $(row).find("td");
        const text = (index: number): string => pyqueryText(columns.eq(index));
        const link = (index: number) => columns.eq(index).find("a").eq(0);

        const orderOfFinish = parsePyInt(text(0));
        const bracketNumber = requirePyInt(text(1), "bracket number");
        const horseNumber = requirePyInt(text(2), "horse number");

        const horseId = requirePyInt(secondLastPathSegment(link(3).attr("href")), "horse id");
        const horseName = pyqueryText(link(3));

        let sex: string | null = null;
        let age = 0;
        const sexAgeMatch = SEX_AGE_PATTERN.exec(text(4));
        if (sexAgeMatch) {
            sex = sexAgeMatch[1] ?? null;
            age = requirePyInt(sexAgeMatch[2] ?? "", "age");
        }
        if (sex == null) {
            throw new ParseError(`sex is missing: race_id=${raceId}, horse_number=${horseNumber}`);
        }

        const basisWeight = requirePyFloat(text(5), "basis weight");

        const jockeyId = secondLastPathSegment(link(6).attr("href"));
        const jockeyName = pyqueryText(link(6));

        let finishingTime: string | null = null;
        const timeMatch = FINISHING_TIME_PATTERN.exec(text(7));
        if (timeMatch) {
            finishingTime = formatFinishingTime(timeMatch[1] ?? "", timeMatch[2] ?? "", timeMatch[3] ?? "");
        }

        let horseWeight: number | null = null;
        let horseWeightDiff: number | null = null;
        const weightMatch = HORSE_WEIGHT_PATTERN.exec(text(14));
        if (weightMatch) {
            horseWeight = requirePyInt(weightMatch[1] ?? "", "horse weight");
            horseWeightDiff = requirePyInt(weightMatch[2] ?? "", "horse weight diff");
        }

        const remarkText = text(17);

        let stable = "不明";
        const stableMatch = STABLE_PATTERN.exec(text(18));
        if (stableMatch) {
            stable = stableMatch[1] ?? stable;
        }

        const trainerId = secondLastPathSegment(link(18).attr("href"));
        const trainerName = pyqueryText(link(18));

        const ownerId = secondLastPathSegment(link(19).attr("href"));
        const ownerName = pyqueryText(link(19));

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
            margin: text(8),
            speedFigure: parsePyInt(text(9)),
            passingRank: text(10),
            lastPhase: parsePyFloat(text(11)),
            odds: parsePyFloat(text(12)),
            popularity: parsePyInt(text(13)),
            horseWeight,
            horseWeightDiff,
            remark: remarkText === "" ? null : remarkText,
            stable,
            trainerId,
            ownerId,
            earningMoney: parsePyFloat(text(20).replaceAll(",", "")) ?? 0,
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
