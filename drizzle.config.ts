import { defineConfig } from "drizzle-kit";

// drizzle-kit が設定ファイルの default export を要求するため このファイルに限りデフォルトエクスポートを使う
export default defineConfig({
    dialect: "postgresql",
    schema: "./src/db/schema.ts",
    out: "./drizzle",
});
