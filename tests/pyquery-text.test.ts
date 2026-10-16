//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { load } from "cheerio";

import { pyqueryText } from "../src/scraper/pyquery-text.ts";

const NBSP = String.fromCharCode(0xa0);
const ZWSP = String.fromCharCode(0x200b);

// 期待値は pyquery 2.x の text() に同じHTMLを通して得た実測値
const CASES: Array<{ name: string; fragment: string; selector: string; expected: string }> = [
    {
        name: "inline spans joined",
        fragment: "<div><span>toto</span><span>tata</span></div>",
        selector: "div",
        expected: "tototata",
    },
    {
        name: "whitespace between spans",
        fragment: "<div><span>toto</span>\n  <span>tata</span></div>",
        selector: "div",
        expected: "toto tata",
    },
    {
        name: "block elements get newlines",
        fragment: "<div><p>a</p><p>b</p></div>",
        selector: "div",
        expected: "a\nb",
    },
    { name: "br becomes newline", fragment: "<div>a<br/>b</div>", selector: "div", expected: "a\nb" },
    {
        name: "multiple elements joined by space",
        fragment: "<ul><li>x</li><li>y</li></ul>",
        selector: "li",
        expected: "x y",
    },
    {
        name: "anchor in cell",
        fragment: '<table><tr><td>\n[東]\n<a href="/t/1/">名前</a>\n\n</td></tr></table>',
        selector: "td",
        expected: "[東] 名前",
    },
    { name: "whitespace squashed", fragment: "<p>  a   b\t\nc  </p>", selector: "p", expected: "a b c" },
    {
        name: "comments ignored",
        fragment: "<div><!-- c -->text<!-- d --> more</div>",
        selector: "div",
        expected: "text more",
    },
    {
        name: "nbsp kept",
        fragment: "<p>a&nbsp;&nbsp;b</p>",
        selector: "p",
        expected: `a${NBSP}${NBSP}b`,
    },
    { name: "empty element", fragment: "<div></div>", selector: "div", expected: "" },
    { name: "no match", fragment: "<div>x</div>", selector: "section", expected: "" },
    {
        name: "nested block matched twice",
        fragment: "<div>top<div>inner</div>tail</div>",
        selector: "div",
        expected: "top\ninner\ntail inner",
    },
    {
        name: "heading with comment",
        fragment: '<h1>2歳未勝利<!--img src="x.png" alt=""--></h1>',
        selector: "h1",
        expected: "2歳未勝利",
    },
    {
        name: "span with nbsp separators",
        fragment:
            "<p><span>\n芝右1200m&nbsp;/&nbsp;\n天候 : 曇&nbsp;/&nbsp;\n芝 : 良&nbsp;&nbsp;/&nbsp;\n発走 : 09:55\n</span><br /></p>",
        selector: "p span",
        expected: `芝右1200m${NBSP}/${NBSP} 天候 : 曇${NBSP}/${NBSP} 芝 : 良${NBSP}${NBSP}/${NBSP} 発走 : 09:55`,
    },
    {
        name: "unknown custom tags",
        fragment: "<table><tr><td>a<diary_snap_cut>b</diary_snap_cut></td></tr></table>",
        selector: "td",
        expected: "a\nb",
    },
    { name: "only block children", fragment: "<div><p></p></div>", selector: "div", expected: "" },
    {
        name: "zero width space is squashed",
        fragment: `<p>a${ZWSP}b</p>`,
        selector: "p",
        expected: "a b",
    },
];

describe("pyqueryText", () => {
    for (const { name, fragment, selector, expected } of CASES) {
        test(name, () => {
            const $ = load(`<html><body>${fragment}</body></html>`);
            expect(pyqueryText($(selector))).toBe(expected);
        });
    }
});
