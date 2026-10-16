//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

// 移植元のスクレイパーが依存していた挙動を再現する小さな関数群
// スクレイピング結果をPython版と一致させるため JavaScript 標準の挙動(trim や Number)とは意図的に分けている

/** HTMLの解析結果が想定の構造と一致しないことを表す */
export class ParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ParseError";
    }
}

// str.strip() が空白とみなす文字 JavaScript の trim() とは対象が異なる
const PY_WHITESPACE_CLASS =
    "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP_PATTERN = new RegExp(`^[${PY_WHITESPACE_CLASS}]+|[${PY_WHITESPACE_CLASS}]+$`, "gu");

/**
 * Pythonのstr.strip()と同じ範囲の空白を前後から取り除く
 *
 * @param text - 対象文字列
 * @returns 前後の空白を除いた文字列
 */
export function pyStrip(text: string): string {
    return text.replace(PY_STRIP_PATTERN, "");
}

const INTEGER_PATTERN = /^[+-]?\d+$/;
const FLOAT_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Pythonのint()相当で文字列を整数へ変換する
 *
 * @param text - 変換対象 前後の空白は許容する
 * @returns 整数 変換できない場合はnull
 */
export function parsePyInt(text: string): number | null {
    const stripped = pyStrip(text);
    if (!INTEGER_PATTERN.test(stripped)) {
        return null;
    }
    const value = Number(stripped);
    return Number.isSafeInteger(value) ? value : null;
}

/**
 * Pythonのfloat()相当で文字列を実数へ変換する
 *
 * 空文字列を0とみなすNumber()とは異なり 空文字列は変換失敗とする
 *
 * @param text - 変換対象 前後の空白は許容する
 * @returns 実数 変換できない場合はnull
 */
export function parsePyFloat(text: string): number | null {
    const stripped = pyStrip(text);
    if (!FLOAT_PATTERN.test(stripped)) {
        return null;
    }
    const value = Number(stripped);
    return Number.isFinite(value) ? value : null;
}

/**
 * parsePyIntの結果が無い場合に例外とする
 *
 * @param text - 変換対象
 * @param label - 例外メッセージに使う項目名
 * @returns 整数
 * @throws {ParseError} 整数へ変換できない場合
 */
export function requirePyInt(text: string, label: string): number {
    const value = parsePyInt(text);
    if (value == null) {
        throw new ParseError(`invalid literal for ${label}: ${JSON.stringify(text)}`);
    }
    return value;
}

/**
 * parsePyFloatの結果が無い場合に例外とする
 *
 * @param text - 変換対象
 * @param label - 例外メッセージに使う項目名
 * @returns 実数
 * @throws {ParseError} 実数へ変換できない場合
 */
export function requirePyFloat(text: string, label: string): number {
    const value = parsePyFloat(text);
    if (value == null) {
        throw new ParseError(`could not convert ${label} to float: ${JSON.stringify(text)}`);
    }
    return value;
}

/**
 * Pythonのstr(href).rsplit("/", 2)[1]と同じ位置の区切り要素を返す
 *
 * hrefが無い場合はPythonでstr(None)が"None"になる挙動に合わせて区切りなしとして扱い例外にする
 *
 * @param href - リンク先 存在しない場合はundefined
 * @returns 末尾の2つ手前の"/"区切り要素
 * @throws {ParseError} "/"が2つ未満で要素を取り出せない場合
 */
export function secondLastPathSegment(href: string | undefined): string {
    const parts = (href ?? "None").split("/");
    const segment = parts.length >= 3 ? parts[parts.length - 2] : undefined;
    if (segment == null) {
        throw new ParseError(`cannot extract id from href: ${JSON.stringify(href)}`);
    }
    return segment;
}

/**
 * 1桁の月日や時分を2桁へそろえる
 *
 * @param value - 数字だけの文字列
 * @returns 2桁以上にゼロ埋めした文字列
 */
export function padTwoDigits(value: string): string {
    return value.padStart(2, "0");
}
