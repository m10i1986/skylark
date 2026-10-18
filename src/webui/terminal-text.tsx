//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { Fragment, memo, type ReactNode } from "react";

// コマンドラインの報告(predict/report.ts)は 端末で「全角=半角2文字分」として桁を揃えている
// ブラウザでは全角の文字が別のフォントで描かれ 幅がちょうど2文字分にならないため そのままでは列がずれる
// 全角の連続部分に文字間隔を足して 1文字をちょうど2文字分(2ch)にする(全角の字の送り幅は1em)

// 東アジアの文字幅が Wide / Fullwidth の範囲(2文字分の幅で表示される文字)
const WIDE_RANGES: ReadonlyArray<readonly [first: number, last: number]> = [
    [0x1100, 0x115f],
    [0x2e80, 0x303e],
    [0x3041, 0x33ff],
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0xa000, 0xa4cf],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xfe30, 0xfe6f],
    [0xff01, 0xff60],
    [0xffe0, 0xffe6],
    [0x1f300, 0x1f64f],
    [0x1f900, 0x1f9ff],
    [0x20000, 0x3fffd],
];

/** 文字の幅の種類 plain=ASCII(フォントの幅のまま) wide=全角(2文字分) single=ASCII以外の1文字分の文字 */
export type CellKind = "plain" | "wide" | "single";

/** 同じ種類が続く文字列 */
export type CellRun = { kind: CellKind; text: string };

function kindOf(codePoint: number): CellKind {
    if (codePoint <= 0x7e) {
        return "plain";
    }
    return WIDE_RANGES.some(([first, last]) => codePoint >= first && codePoint <= last) ? "wide" : "single";
}

/**
 * 1行を 幅の種類が同じ文字列ごとに分ける
 *
 * 「★」や半角カナのように ASCII以外で全角でない文字は single にする(桁を数えるとき1文字分として扱われるため)
 *
 * @param line - 改行を含まない1行
 * @returns 幅の種類が続く区間
 */
export function splitTerminalLine(line: string): CellRun[] {
    const runs: CellRun[] = [];
    for (const character of line) {
        const kind = kindOf(character.codePointAt(0) ?? 0);
        const last = runs.at(-1);
        if (last?.kind === kind) {
            last.text += character;
        } else {
            runs.push({ kind, text: character });
        }
    }
    return runs;
}

function renderRun(run: CellRun): ReactNode {
    switch (run.kind) {
        case "plain":
            return run.text;
        case "wide":
            return <span className="tracking-[calc(2ch_-_1em)]">{run.text}</span>;
        case "single":
            return [...run.text].map((character, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同じ文字が並び得る 並べ替えない
                <span key={index} className="inline-block w-[1ch]">
                    {character}
                </span>
            ));
    }
}

/**
 * 端末向けに桁を揃えた文章を 列がずれないよう表示する
 *
 * 等幅フォントの要素(pre)の中で使う 文字は元の文章のままで 選択やコピーの結果も変わらない
 */
export const TerminalText = memo(function TerminalText({ text }: { text: string }): ReactNode {
    const lines = text.split("\n");
    return lines.map((line, lineIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 行は並べ替えない 同じ内容の行が並び得る
        <Fragment key={lineIndex}>
            {splitTerminalLine(line).map((run, runIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 区間は並べ替えない
                <Fragment key={runIndex}>{renderRun(run)}</Fragment>
            ))}
            {lineIndex < lines.length - 1 ? "\n" : null}
        </Fragment>
    ));
});
