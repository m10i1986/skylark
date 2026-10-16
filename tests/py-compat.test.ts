//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import {
    ParseError,
    padTwoDigits,
    parsePyFloat,
    parsePyInt,
    pyStrip,
    requirePyFloat,
    requirePyInt,
    secondLastPathSegment,
} from "../src/scraper/py-compat.ts";

const NBSP = String.fromCharCode(0xa0);
const NEXT_LINE = String.fromCharCode(0x85);
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

describe("pyStrip", () => {
    test("strips whitespace the way Python str.strip does", () => {
        expect(pyStrip(`${NBSP} ab ${IDEOGRAPHIC_SPACE}`)).toBe("ab");
        expect(pyStrip(`${NEXT_LINE}ab${NEXT_LINE}`)).toBe("ab");
        expect(pyStrip("\t\r\n ab \f\v")).toBe("ab");
    });

    test("keeps characters Python does not treat as whitespace", () => {
        expect(pyStrip(`${BYTE_ORDER_MARK}ab`)).toBe(`${BYTE_ORDER_MARK}ab`);
    });

    test("only strips the ends", () => {
        expect(pyStrip(" a b ")).toBe("a b");
    });
});

describe("parsePyInt", () => {
    test("accepts signed integers with surrounding whitespace", () => {
        expect(parsePyInt(" 42 ")).toBe(42);
        expect(parsePyInt("-4")).toBe(-4);
        expect(parsePyInt("+7")).toBe(7);
        expect(parsePyInt("007")).toBe(7);
    });

    test("rejects anything else", () => {
        expect(parsePyInt("")).toBeNull();
        expect(parsePyInt("1.0")).toBeNull();
        expect(parsePyInt("12a")).toBeNull();
        expect(parsePyInt("---")).toBeNull();
        expect(parsePyInt("99999999999999999999")).toBeNull();
    });
});

describe("parsePyFloat", () => {
    test("accepts decimal notation", () => {
        expect(parsePyFloat("55")).toBe(55);
        expect(parsePyFloat(" 34.5 ")).toBe(34.5);
        expect(parsePyFloat(".5")).toBe(0.5);
        expect(parsePyFloat("1e3")).toBe(1000);
    });

    test("treats an empty string as a failure unlike Number()", () => {
        expect(Number("")).toBe(0);
        expect(parsePyFloat("")).toBeNull();
        expect(parsePyFloat("   ")).toBeNull();
    });

    test("rejects non numeric text", () => {
        expect(parsePyFloat("---")).toBeNull();
        expect(parsePyFloat("1,5")).toBeNull();
        expect(parsePyFloat("abc")).toBeNull();
    });
});

describe("requirePyInt and requirePyFloat", () => {
    test("return the value when valid", () => {
        expect(requirePyInt("12", "x")).toBe(12);
        expect(requirePyFloat("1.5", "x")).toBe(1.5);
    });

    test("throw ParseError with the label when invalid", () => {
        expect(() => requirePyInt("a", "horse id")).toThrow(ParseError);
        expect(() => requirePyInt("a", "horse id")).toThrow("horse id");
        expect(() => requirePyFloat("", "weight")).toThrow(ParseError);
    });
});

describe("secondLastPathSegment", () => {
    test("returns the segment before the trailing slash like rsplit('/', 2)[1]", () => {
        expect(secondLastPathSegment("/horse/2019104251/")).toBe("2019104251");
        expect(secondLastPathSegment("/jockey/result/recent/01102/")).toBe("01102");
        expect(secondLastPathSegment("a/b/c")).toBe("b");
    });

    test("returns the directory name when there is no trailing slash", () => {
        expect(secondLastPathSegment("/horse/2019104251")).toBe("horse");
    });

    test("throws ParseError when the href is missing or has too few slashes", () => {
        expect(() => secondLastPathSegment(undefined)).toThrow(ParseError);
        expect(() => secondLastPathSegment("abc")).toThrow(ParseError);
        expect(() => secondLastPathSegment("a/b")).toThrow(ParseError);
    });
});

describe("padTwoDigits", () => {
    test("pads to two digits and keeps longer values", () => {
        expect(padTwoDigits("5")).toBe("05");
        expect(padTwoDigits("12")).toBe("12");
        expect(padTwoDigits("123")).toBe("123");
    });
});
