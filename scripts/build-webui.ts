//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

// Web UIのクライアント(JSとCSS)を dist/webui へ作る
// Tailwind CSSはbun-plugin-tailwindがstyles.cssから生成する

import { resolve } from "node:path";

import tailwind from "bun-plugin-tailwind";

const rootDirectory = resolve(import.meta.dir, "..");

const result = await Bun.build({
    entrypoints: [resolve(rootDirectory, "src/webui/client.tsx")],
    outdir: resolve(rootDirectory, "dist/webui"),
    target: "browser",
    format: "esm",
    minify: true,
    // 出力の名前を固定し サーバーの配信と合わせる
    naming: { entry: "app.[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [tailwind],
});

if (!result.success) {
    for (const log of result.logs) {
        console.error(log);
    }
    process.exit(1);
}
for (const output of result.outputs) {
    console.info(`${output.path} (${output.size} bytes)`);
}
