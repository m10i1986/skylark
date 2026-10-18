import { defineConfig } from "drizzle-kit";

// config.ts の読み込み時に .env が環境変数へ反映される
import { loadDatabaseConfig } from "./src/config.ts";

const database = loadDatabaseConfig();

// drizzle-kit が設定ファイルの default export を要求するため このファイルに限りデフォルトエクスポートを使う
export default defineConfig({
    dialect: "postgresql",
    schema: "./src/db/schema.ts",
    out: "./drizzle",
    // アプリ本体(src/db/client.ts)と同じく DATABASE_URL を優先し 無ければ POSTGRES_* の個別項目を使う
    dbCredentials:
        database.url != null
            ? { url: database.url }
            : {
                  host: database.hostname,
                  port: database.port,
                  user: database.username,
                  password: database.password,
                  database: database.database,
                  // 未指定だと drizzle-kit が ssl: {} を pg へ渡して TLS 必須になり TLS 非対応の DB へ接続できない
                  ssl: false,
              },
});
