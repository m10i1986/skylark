//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { hydrateRoot } from "react-dom/client";

import "./styles.css";
import { PROPS_ELEMENT_ID, ROOT_ELEMENT_ID } from "./dom-ids.ts";
import { IndexPage, type PageProps } from "./views.tsx";

// サーバーが描画した画面を同じ値で引き継ぎ 選択欄を操作できるようにする
const root = document.getElementById(ROOT_ELEMENT_ID);
const propsElement = document.getElementById(PROPS_ELEMENT_ID);
if (root != null && propsElement?.textContent) {
    // 値はサーバーが同じ型から作ったJSONで 外部の入力ではない
    const props = JSON.parse(propsElement.textContent) as PageProps;
    hydrateRoot(root, <IndexPage {...props} />);
}
