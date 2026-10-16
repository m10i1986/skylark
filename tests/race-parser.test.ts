//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { ParseError } from "../src/scraper/py-compat.ts";
import { loadRaceDocument, parsePayoffs, parseRaceInfo, parseRaceResults } from "../src/scraper/race-parser.ts";
import { buildRacePageHtml, SECOND_ROW, WINNER_ROW } from "./race-page-fixture.ts";

const RACE_ID = 209901010101;

// 期待値は同じHTMLを移植元のPython版パーサに通して得た値(時刻と日付のゼロ埋め 数値型は移植での意図的な差)
describe("parseRaceInfo", () => {
    test("extracts race information from the default page", () => {
        const info = parseRaceInfo(RACE_ID, loadRaceDocument(buildRacePageHtml()));
        expect(info).toEqual({
            id: RACE_ID,
            raceName: "テスト未勝利",
            distance: 1200,
            weather: "曇",
            postTime: "09:55",
            raceNumber: 1,
            runDirection: "右",
            trackSurface: "芝",
            trackCondition: "良",
            trackConditionScore: null,
            date: "2025-07-06",
            placeDetail: "1回札幌1日目",
            raceGrade: 4,
            raceClass: "2歳未勝利  (混)[指](馬齢)",
        });
    });

    test("handles outer course, one digit month and open class", () => {
        const html = buildRacePageHtml({
            raceNumberText: "11 R",
            raceDataLines: "芝右外1600m&nbsp;/&nbsp;\n天候 : 晴&nbsp;/&nbsp;\n芝 : 稍重&nbsp;/&nbsp;\n発走 : 9:05",
            dateLine: "2025年7月6日 2回東京3日目 3歳以上オープン  (国際)(指)",
        });
        const info = parseRaceInfo(RACE_ID, loadRaceDocument(html));
        expect(info).toMatchObject({
            raceNumber: 11,
            distance: 1600,
            weather: "晴",
            trackCondition: "稍重",
            trackSurface: "芝",
            runDirection: "右 外",
            postTime: "09:05",
            date: "2025-07-06",
            placeDetail: "2回東京3日目",
            raceGrade: 0,
            raceClass: "3歳以上オープン (国際)(指)",
        });
    });

    test("leaves course fields null when the race data line does not match", () => {
        const html = buildRacePageHtml({ raceDataLines: "情報なし" });
        const info = parseRaceInfo(RACE_ID, loadRaceDocument(html));
        expect(info).toMatchObject({
            distance: null,
            weather: null,
            postTime: null,
            trackSurface: null,
            trackCondition: null,
            runDirection: null,
        });
    });

    test.each(["1 R", "1R", "11R", "12 R", "3"])("accepts the race number notation %p", (text) => {
        const info = parseRaceInfo(RACE_ID, loadRaceDocument(buildRacePageHtml({ raceNumberText: text })));
        expect(info.raceNumber).toBe(Number.parseInt(text, 10));
    });

    test("throws ParseError when the race number is missing", () => {
        const html = buildRacePageHtml({ raceNumberText: "" });
        expect(() => parseRaceInfo(RACE_ID, loadRaceDocument(html))).toThrow(ParseError);
    });

    test("throws ParseError when the race number is not numeric", () => {
        const html = buildRacePageHtml({ raceNumberText: "特別 R" });
        expect(() => parseRaceInfo(RACE_ID, loadRaceDocument(html))).toThrow(ParseError);
    });

    test("throws ParseError when the date line does not match", () => {
        const html = buildRacePageHtml({ dateLine: "日付不明" });
        expect(() => parseRaceInfo(RACE_ID, loadRaceDocument(html))).toThrow(ParseError);
    });
});

describe("parseRaceResults", () => {
    const resultSet = parseRaceResults(RACE_ID, loadRaceDocument(buildRacePageHtml()));

    test("extracts every horse in order", () => {
        expect(resultSet.results.map((result) => result.horseNumber)).toEqual([3, 4, 5]);
    });

    test("extracts a finished horse", () => {
        expect(resultSet.results[0]).toEqual({
            raceId: RACE_ID,
            horseNumber: 3,
            orderOfFinish: 1,
            bracketNumber: 3,
            horseId: 2099100001,
            sex: "牝",
            age: 2,
            basisWeight: 55,
            jockeyId: "01001",
            finishingTime: "00:01:08.9",
            margin: "",
            speedFigure: null,
            passingRank: "6-5",
            lastPhase: 34.1,
            odds: 4.8,
            popularity: 3,
            horseWeight: 408,
            horseWeightDiff: 4,
            remark: null,
            stable: "東",
            trainerId: "01002",
            ownerId: "331002",
            earningMoney: 1560,
        });
    });

    test("keeps leading zeros of jockey, trainer and owner ids", () => {
        expect(resultSet.results[1]).toMatchObject({ jockeyId: "00002", trainerId: "05003", ownerId: "000123" });
        expect(resultSet.owners.map((owner) => owner.id)).toEqual(["331002", "000123", "331002"]);
    });

    test("parses margin, remark and a negative weight difference", () => {
        expect(resultSet.results[1]).toMatchObject({
            margin: "1.1/4",
            remark: "出遅れ",
            horseWeight: 466,
            horseWeightDiff: -2,
            stable: "西",
        });
    });

    test("uses null or defaults for an excluded horse", () => {
        expect(resultSet.results[2]).toMatchObject({
            orderOfFinish: null,
            finishingTime: null,
            lastPhase: null,
            odds: null,
            popularity: null,
            horseWeight: null,
            horseWeightDiff: null,
            earningMoney: 0,
            sex: "セ",
            age: 3,
        });
    });

    test("collects master records", () => {
        expect(resultSet.horses[0]).toEqual({ id: 2099100001, horseName: "テストホースA" });
        expect(resultSet.jockeys[0]).toEqual({ id: "01001", jockeyName: "騎手テスト" });
        expect(resultSet.trainers[0]).toEqual({ id: "01002", trainerName: "調教師テスト" });
        expect(resultSet.owners[0]).toEqual({ id: "331002", ownerName: "馬主テスト" });
    });

    test("pads a single digit minute of the finishing time", () => {
        const html = buildRacePageHtml({
            rows: [
                { ...WINNER_ROW, time: "0:59.0" },
                { ...SECOND_ROW, time: "2:30.5" },
            ],
        });
        const times = parseRaceResults(RACE_ID, loadRaceDocument(html)).results.map((r) => r.finishingTime);
        expect(times).toEqual(["00:00:59.0", "00:02:30.5"]);
    });

    test("throws ParseError when the sex and age cell does not match", () => {
        const html = buildRacePageHtml({ rows: [{ ...WINNER_ROW, sexAge: "不明" }] });
        expect(() => parseRaceResults(RACE_ID, loadRaceDocument(html))).toThrow(ParseError);
    });

    test("throws ParseError when the bracket number is not numeric", () => {
        const html = buildRacePageHtml({ rows: [{ ...WINNER_ROW, bracket: "x" }] });
        expect(() => parseRaceResults(RACE_ID, loadRaceDocument(html))).toThrow(ParseError);
    });

    test("throws ParseError when the weight is empty", () => {
        const html = buildRacePageHtml({ rows: [{ ...WINNER_ROW, weight: "" }] });
        expect(() => parseRaceResults(RACE_ID, loadRaceDocument(html))).toThrow(ParseError);
    });

    test("returns an empty set when there is no result table", () => {
        const resultSetEmpty = parseRaceResults(RACE_ID, loadRaceDocument("<html><body></body></html>"));
        expect(resultSetEmpty.results).toEqual([]);
    });
});

describe("parsePayoffs", () => {
    test("expands multi line cells into one record per line", () => {
        const payoffs = parsePayoffs(RACE_ID, loadRaceDocument(buildRacePageHtml()), () => {});
        expect(payoffs).toEqual([
            { raceId: RACE_ID, ticketType: 0, horseNumbers: "3", payoff: 480, popularity: 3 },
            { raceId: RACE_ID, ticketType: 1, horseNumbers: "3", payoff: 130, popularity: 2 },
            { raceId: RACE_ID, ticketType: 1, horseNumbers: "4", payoff: 110, popularity: 1 },
            { raceId: RACE_ID, ticketType: 1, horseNumbers: "2", payoff: 1140, popularity: 3 },
            { raceId: RACE_ID, ticketType: 3, horseNumbers: "3-4", payoff: 590, popularity: 2 },
            { raceId: RACE_ID, ticketType: 5, horseNumbers: "3-4", payoff: 240, popularity: 1 },
            { raceId: RACE_ID, ticketType: 5, horseNumbers: "2-3", payoff: 360, popularity: 5 },
            { raceId: RACE_ID, ticketType: 5, horseNumbers: "2-4", payoff: 260, popularity: 2 },
            { raceId: RACE_ID, ticketType: 6, horseNumbers: "3->4", payoff: 1500, popularity: 5 },
            { raceId: RACE_ID, ticketType: 8, horseNumbers: "3->4->2", payoff: 4960, popularity: 8 },
        ]);
    });

    test("skips an unknown ticket type and reports it", () => {
        const unknown: string[] = [];
        const html = buildRacePageHtml({
            payoffRows: [
                { label: "特殊", horseNumbers: "1", payoff: "100", popularity: "1" },
                { label: "単勝", horseNumbers: "3", payoff: "480", popularity: "3" },
            ],
        });
        const payoffs = parsePayoffs(RACE_ID, loadRaceDocument(html), (label) => unknown.push(label));
        expect(unknown).toEqual(["特殊"]);
        expect(payoffs).toHaveLength(1);
    });

    test("throws ParseError when a line has no matching payoff", () => {
        const html = buildRacePageHtml({
            payoffRows: [{ label: "複勝", horseNumbers: "3<br />4", payoff: "130", popularity: "2<br />1" }],
        });
        expect(() => parsePayoffs(RACE_ID, loadRaceDocument(html), () => {})).toThrow(ParseError);
    });

    test("accepts self closing and upper case br tags", () => {
        const html = buildRacePageHtml({
            payoffRows: [{ label: "複勝", horseNumbers: "3<BR/>4", payoff: "130<br>110", popularity: "2<br />1" }],
        });
        expect(parsePayoffs(RACE_ID, loadRaceDocument(html), () => {})).toHaveLength(2);
    });
});
