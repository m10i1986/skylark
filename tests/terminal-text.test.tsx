//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { splitTerminalLine, TerminalText } from "../src/webui/terminal-text.tsx";

// タグを除いた文字列 見た目のために足した要素が 文字そのものを変えないことを確かめる
function textOf(markup: string): string {
    return markup
        .replace(/<[^>]*>/g, "")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
}

describe("splitTerminalLine", () => {
    test("separates ASCII, full-width and single-cell symbols", () => {
        expect(splitTerminalLine("★ 1 シーラー  2.5")).toEqual([
            { kind: "single", text: "★" },
            { kind: "plain", text: " 1 " },
            { kind: "wide", text: "シーラー" },
            { kind: "plain", text: "  2.5" },
        ]);
    });

    test("treats Japanese text, full-width letters and symbols as wide", () => {
        for (const text of ["人気", "ゴールドショーマン", "ｅｆ", "・", "「」", "ぁ", "漢"]) {
            expect(splitTerminalLine(text)).toEqual([{ kind: "wide", text }]);
        }
    });

    test("treats half-width kana and symbols that terminals count as one cell as single", () => {
        for (const text of ["ﾊﾝｶｸ", "★", "■", "±", "→"]) {
            expect(splitTerminalLine(text)).toEqual([{ kind: "single", text }]);
        }
    });

    test("keeps characters outside the BMP whole", () => {
        // 𠮷(U+20BB7)は2文字分の幅 サロゲートペアを分けない
        expect(splitTerminalLine("a𠮷b")).toEqual([
            { kind: "plain", text: "a" },
            { kind: "wide", text: "𠮷" },
            { kind: "plain", text: "b" },
        ]);
    });

    test("returns nothing for an empty line", () => {
        expect(splitTerminalLine("")).toEqual([]);
    });
});

describe("TerminalText", () => {
    const REPORT = ["■ 新潟1R 09:40発走", "  人気 馬名      オッズ", "★    4 ブルーリボン   24.4", "", "(末尾)"].join(
        "\n",
    );

    test("renders exactly the same characters, so that copying gives the original text", () => {
        expect(textOf(renderToStaticMarkup(<TerminalText text={REPORT} />))).toBe(REPORT);
    });

    test("keeps blank lines and does not add a trailing line break", () => {
        const text = textOf(renderToStaticMarkup(<TerminalText text={"a\n\nb"} />));
        expect(text).toBe("a\n\nb");
        expect(textOf(renderToStaticMarkup(<TerminalText text={"a\n"} />))).toBe("a\n");
    });

    test("widens each full-width run to two cells per character and pins symbols to one cell", () => {
        const markup = renderToStaticMarkup(<TerminalText text="★ ブルー" />);
        expect(markup).toContain('<span class="inline-block w-[1ch]">★</span>');
        expect(markup).toContain('<span class="tracking-[calc(2ch_-_1em)]">ブルー</span>');
    });

    test("does not touch plain ASCII", () => {
        expect(renderToStaticMarkup(<TerminalText text="  24.4  3.2%" />)).toBe("  24.4  3.2%");
    });

    test("escapes markup in the text", () => {
        const markup = renderToStaticMarkup(<TerminalText text="<b>x</b> あ" />);
        expect(markup).not.toContain("<b>");
        expect(textOf(markup)).toBe("<b>x</b> あ");
    });
});
