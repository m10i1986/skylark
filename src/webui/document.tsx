//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { renderToString } from "react-dom/server";

import { App, type AppProps } from "./app.tsx";
import { PROPS_ELEMENT_ID, ROOT_ELEMENT_ID } from "./dom-ids.ts";

// JSONをscript要素へ埋め込むとき 「</script>」などで要素を閉じられないよう「<」を置き換える
function toEmbeddedJson(value: unknown): string {
    return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/**
 * 画面のHTML全体を作る
 *
 * 画面はサーバーで描画し クライアントのスクリプトが同じ値で引き継ぐ
 *
 * @param props - 画面の描画に必要な値
 * @returns HTML文書
 */
export function renderDocument(props: AppProps): string {
    const body = renderToString(<App {...props} />);
    return [
        "<!DOCTYPE html>",
        '<html lang="ja">',
        '<head><meta charset="utf-8" />',
        '<meta name="viewport" content="width=device-width, initial-scale=1" />',
        "<title>Skylark</title>",
        '<link rel="stylesheet" href="/assets/app.css" /></head>',
        `<body><div id="${ROOT_ELEMENT_ID}">${body}</div>`,
        `<script id="${PROPS_ELEMENT_ID}" type="application/json">${toEmbeddedJson(props)}</script>`,
        '<script type="module" src="/assets/app.js"></script>',
        "</body></html>",
    ].join("");
}
