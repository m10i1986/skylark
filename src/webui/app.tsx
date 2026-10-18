//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import type { ReactNode } from "react";

import { JobPage, type JobPageProps, OperationsPage, type OperationsPageProps } from "./operations-views.tsx";
import { IndexPage, type IndexPageProps } from "./views.tsx";

/** 画面の描画に必要な値 JSONにできる値だけを持つ(クライアントへそのまま渡す) page で画面を見分ける */
export type AppProps =
    | ({ page: "index" } & IndexPageProps)
    | ({ page: "operations" } & OperationsPageProps)
    | ({ page: "job" } & JobPageProps);

/**
 * 画面の種類に応じた画面を選ぶ
 *
 * サーバーの描画とブラウザの引き継ぎで同じ画面になるよう 両方がこの部品から描く
 */
export function App(props: AppProps): ReactNode {
    switch (props.page) {
        case "index":
            return <IndexPage {...props} />;
        case "operations":
            return <OperationsPage {...props} />;
        case "job":
            return <JobPage {...props} />;
    }
}
