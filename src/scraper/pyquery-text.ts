//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

// pyquery 2.x の text() を再現する
// cheerio の text() は単純連結のため 空白圧縮やブロック要素の改行が入る pyquery と結果が変わる
// 正規表現による抽出結果をPython版と一致させる目的で pyquery/text.py の手順をそのまま移植している

import type { Cheerio } from "cheerio";
import { type AnyNode, type Element, isTag } from "domhandler";

import { pyStrip } from "./py-compat.ts";

// text()の中間表現 string=本文 null=ブロック境界で挿入した改行 true=brによる改行
type Part = string | null | true;

const INLINE_TAGS: ReadonlySet<string> = new Set([
    "a",
    "abbr",
    "acronym",
    "b",
    "bdo",
    "big",
    "br",
    "button",
    "cite",
    "code",
    "dfn",
    "em",
    "i",
    "img",
    "input",
    "kbd",
    "label",
    "map",
    "object",
    "q",
    "samp",
    "script",
    "select",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "textarea",
    "time",
    "tt",
    "var",
]);

const SEPARATORS: ReadonlySet<string> = new Set(["br"]);

// HTMLの空白定義(スペース タブ フォームフィード ゼロ幅スペース 改行)
const HTML_WHITESPACE = /[ \t\f\n\r\u{200b}]+/gu;

function squashHtmlWhitespace(text: string): string {
    return text.replace(HTML_WHITESPACE, " ");
}

// 連続するブロック境界を1つにまとめる
function squashArtificialNewlines(parts: readonly Part[]): Part[] {
    const output: Part[] = [];
    let isLastNewline = false;
    for (const part of parts) {
        if (part !== null) {
            output.push(part);
            isLastNewline = false;
        } else if (!isLastNewline) {
            output.push(null);
            isLastNewline = true;
        }
    }
    return output;
}

// 先頭と末尾のブロック境界を取り除く 本文が無い場合の挙動(末尾要素だけ残る)も原実装に合わせる
function stripArtificialNewlines(parts: Part[]): Part[] {
    if (parts.length === 0) {
        return parts;
    }

    let startIndex = 0;
    for (let index = 0; index < parts.length; index++) {
        startIndex = index;
        if (typeof parts[index] === "string") {
            break;
        }
    }

    // 原実装は parts[:startIndex - 1 if startIndex > 0 else None:-1] を末尾から走査する 走査の下限は常にstartIndex
    let endIndex = 0;
    for (let cursor = parts.length - 1, step = 0; cursor >= startIndex; cursor--, step++) {
        endIndex = step;
        if (typeof parts[cursor] === "string") {
            break;
        }
    }

    return parts.slice(startIndex, endIndex > 0 ? -endIndex : undefined);
}

// 隣り合う本文を連結して空白を圧縮する
function mergeOriginalParts(parts: readonly Part[]): Part[] {
    const output: Part[] = [];
    let buffer: string[] = [];

    const flush = (): void => {
        if (buffer.length > 0) {
            const item = pyStrip(squashHtmlWhitespace(buffer.join("")));
            if (item !== "") {
                output.push(item);
            }
            buffer = [];
        }
    };

    for (const part of parts) {
        if (typeof part !== "string") {
            flush();
            output.push(part);
        } else {
            buffer.push(part);
        }
    }
    flush();
    return output;
}

function extractTextArray(node: Element, isSquashing: boolean, isStripping: boolean): Part[] {
    let parts: Part[] = [];

    if (SEPARATORS.has(node.name)) {
        parts.push(true);
    } else if (!INLINE_TAGS.has(node.name)) {
        parts.push(null);
    }

    for (const child of node.children) {
        if (child.type === "text") {
            parts.push(child.data);
        } else if (isTag(child)) {
            parts.push(...extractTextArray(child, false, false));
        }
        // コメントなどは lxml では空文字を返すだけなので何も追加しない
    }

    if (!INLINE_TAGS.has(node.name) && !SEPARATORS.has(node.name)) {
        parts.push(null);
    }

    if (isSquashing) {
        parts = squashArtificialNewlines(parts);
    }
    if (isStripping) {
        parts = stripArtificialNewlines(parts);
    }
    return parts;
}

function extractText(node: Element): string {
    let parts = extractTextArray(node, true, true);
    parts = stripArtificialNewlines(squashArtificialNewlines(mergeOriginalParts(parts)));
    const joined = parts.map((part) => (typeof part === "string" ? part : "\n")).join("");
    return pyStrip(joined);
}

/**
 * pyqueryのtext()と同じ規則で選択要素のテキストを取り出す
 *
 * 複数要素の場合はそれぞれのテキストを半角スペースで連結する 要素が無い場合は空文字列を返す
 *
 * @param selection - cheerioで選択した要素
 * @returns 空白を圧縮したテキスト
 */
export function pyqueryText(selection: Cheerio<AnyNode>): string {
    const texts: string[] = [];
    for (const node of selection.toArray()) {
        if (isTag(node)) {
            texts.push(extractText(node));
        }
    }
    return texts.join(" ");
}
