//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { raceClassToInt, ticketTypeToInt } from "../src/util.ts";

describe("ticketTypeToInt", () => {
    test("maps each ticket type to its index", () => {
        const labels = ["単勝", "複勝", "枠単", "枠連", "馬連", "ワイド", "馬単", "三連複", "三連単"];
        expect(labels.map((label) => ticketTypeToInt(label))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    });

    test("returns null for unknown, empty and missing input", () => {
        expect(ticketTypeToInt("特殊")).toBeNull();
        expect(ticketTypeToInt("")).toBeNull();
        expect(ticketTypeToInt(null)).toBeNull();
        expect(ticketTypeToInt(undefined)).toBeNull();
    });
});

describe("raceClassToInt", () => {
    test("matches a class that appears after the first character", () => {
        expect(raceClassToInt("3歳以上オープン")).toBe(0);
        expect(raceClassToInt("3歳1600万下")).toBe(1);
        expect(raceClassToInt("2歳未勝利")).toBe(4);
        expect(raceClassToInt("2歳新馬")).toBe(5);
    });

    test("does not match a class at the very start of the text", () => {
        expect(raceClassToInt("オープン")).toBeNull();
        expect(raceClassToInt("未勝利")).toBeNull();
    });

    test("returns null for empty and missing input", () => {
        expect(raceClassToInt("")).toBeNull();
        expect(raceClassToInt(null)).toBeNull();
        expect(raceClassToInt("重賞")).toBeNull();
    });
});
