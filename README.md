# Skylark
Skylark - 雲雀(競馬予測素体作成)

netkeiba.com のレース結果を取得して PostgreSQL へ保存し、馬ごとの特徴量を計算します。
Bun と TypeScript で動作し、DB アクセスには Drizzle ORM を使います。

## 必要なもの

| 項目 | 内容 |
|:---|:---|
| [Bun](https://bun.sh/) | 1.3 以上(実行環境) |
| [pnpm](https://pnpm.io/) | 依存パッケージの管理 |
| PostgreSQL | 18 で動作確認 |
| Chromium | Web UI だけで使用 |

## DB の準備

管理者(`postgres`)で次を実行します。パスワードは対話入力にして、シェル履歴へ残さないようにします。

```sql
CREATE ROLE skylark WITH LOGIN;
\password skylark
CREATE DATABASE skylark WITH OWNER = skylark ENCODING = 'UTF8';
```

TCP で接続する場合は、`pg_hba.conf` に `host skylark skylark 127.0.0.1/32 scram-sha-256` のような行が必要です。

テーブルは起動時に自動で作成されます(Drizzle のマイグレーション)。

## セットアップ

```bash
git clone git@github.com:m10i-0nyx/skylark.git
cd skylark
pnpm install
cp .env.example .env    # POSTGRES_PASSWORD などを編集する
```

Web UI を使う場合は、Chromium を用意します。

```bash
# Playwright が管理するブラウザを入れる
pnpm exec playwright install chromium-headless-shell

# または OS のブラウザを使う(.env の CHROMIUM_EXECUTABLE_PATH へ指定する)
sudo dnf install -y chromium-headless at-spi2-atk
```

## 使い方

```bash
# レース一覧の更新(-U) → ダウンロードと保存(-S) → 特徴量の計算(-F)
bun run src/cli.ts -U -S -F

# 指定したレースだけ取得する
bun run src/cli.ts -S 202501010101 202501010102

# Web UI(既定は http://127.0.0.1:8501/)
# 画面のJSとCSSを dist/webui へ作ってから起動する
pnpm webui
```

`scraper.sh` と `webui.sh` は、それぞれ上の `cli.ts` と Web UI を起動するだけの短いスクリプトです。`webui.sh` も、起動前に画面のJSとCSSを作ります。

### コマンドラインオプション

| オプション | 内容 | 既定値 |
|:---|:---|:---|
| `-U`, `--update-race-list` | レース一覧を更新する | - |
| `-S`, `--scraping` | レース結果をダウンロードして保存する | - |
| `-F`, `--feature` | 特徴量を計算する | - |
| `-Rf`, `--rebuild-feature` | 特徴量テーブルを空にして計算し直す | - |
| `--rebuild-all-tables` | 全テーブルの行を削除する | - |
| `--temp DIR` | HTML のキャッシュを置くディレクトリ | `./temp` |
| `--race-list-file FILE` | レース一覧のファイル名(`--temp` の下) | `race_list.txt` |
| `--period-of-months N` | 一覧を遡る月数 | `12` |
| `--debug` | デバッグログを出す | - |
| `race_id ...` | 取得するレース ID(`-S` と併用。省略時は一覧ファイル) | - |

終了コードは、正常が 0、処理の失敗が 1、引数の誤りが 2 です。

### 環境変数

`.env.example` を参照してください。DB の接続先は、`DATABASE_URL` または `POSTGRES_*` で指定します。
パスワードの既定値はありません。

## 構成

| パス | 内容 |
|:---|:---|
| `src/cli.ts`, `src/cli-args.ts` | コマンドライン |
| `src/db/` | スキーマ(`schema.ts`)、リポジトリ(`crud.ts`)、接続とマイグレーション(`client.ts`) |
| `src/scraper/` | ダウンロード、HTML の解析、レース一覧の作成 |
| `src/feature.ts` | 特徴量の計算 |
| `src/webui/` | Web UI(Hono + Playwright。画面は React + [shadcn/ui](https://ui.shadcn.com/)) |
| `scripts/build-webui.ts` | 画面のJSとCSS(Tailwind CSS)を `dist/webui` へ作る(`pnpm build:webui`) |
| `drizzle/` | マイグレーション SQL(自動生成) |
| `tests/` | テスト |

### Web UI の画面

画面はサーバーで描画し(React の `renderToString`)、ブラウザ側のスクリプト(`src/webui/client.tsx`)が同じ値で引き継ぎます。選択欄などの操作はこの引き継ぎ後に動きます。

- `src/webui/views.tsx`: 画面の部品。サーバーとブラウザの両方で使います。
- `src/webui/components/ui/`: shadcn/ui の部品。設定は `components.json`、テーマは `src/webui/styles.css` です。
- ダーク/ライトは OS の設定(`prefers-color-scheme`)に従います。

部品を足すときは、次のコマンドを使います。

```bash
pnpm exec shadcn add <部品名>
```

追加後は `pnpm exec biome check --write src/webui` で整形してください。

テーブル定義を変えたら、次のコマンドでマイグレーションを生成します。起動時に未適用分が自動で適用されます。

```bash
pnpm db:generate
```

## テストと検査

```bash
bun test              # 単体テスト(PGlite = インプロセスのPostgreSQLを使うためDBサーバーは不要)
pnpm typecheck        # 型検査
pnpm lint             # Biome
```

実ブラウザを使うテストは、`CHROMIUM_EXECUTABLE_PATH` かインストール済みのブラウザがあれば実行され、無ければ自動でスキップされます。

## Python 版(MySQL)からの移行

- `temp/` の `race.<id>.html.zst` は、そのまま使えます。キャッシュがあるレースは通信せずに `temp/` から読み込まれるため、DB の再構築に使えます。
  - レース ID を指定しない `-S` が対象にするのは `temp/race_list.txt` に載っているレースだけです。一覧に載っていないキャッシュ(例：古い年のもの)は、`bun run src/cli.ts -S <レースID>...` のように ID を指定してください。
  - 一覧に載っていてキャッシュが無いレースは、サイトから取得するため通信が発生します。
- MySQL のデータを引き継ぐ機能はありません。上の方法で作り直してください。
- 環境変数は `MYSQL_*` から `POSTGRES_*` へ変わりました。
- 保存内容の違い
  - 完走タイムは 0.1 秒の精度で保存されます。MySQL の `TIME` は秒に丸めていました。
  - 特徴量は jsonb のオブジェクトとして保存されます。Python 版は JSON 文字列を JSON として二重に保存していました。
  - 特徴量の平均値は、Python 版が内部の型の都合で保存に失敗する場合がありました。今回は数値で保存します。
  - 騎手・調教師・馬主の ID は、先頭の 0 を保つ文字列です。

## 既知の制約

- 結果表の列は、位置ではなく見出しの文字列で決めています。旧形式(21 列)と現行(25 列)のどちらも解析できます。必須の見出しが無い、または行の列数が見出しと違うページは、`ParseError` としてログへ記録し、そのレースの結果は保存しません。
- レース一覧(`-U`)は、月のカレンダー API(`/race/ajax_race_calendar.html`)から開催日を集めます。今月から `--period-of-months` か月ぶんを遡り、今日より後の日は取得しません。中央競馬と地方競馬の両方が対象です。
- ばんえい競馬(レース ID の 5〜6 桁目が `65`)は対象外です。馬 ID が `B202300104` のような英数字で、DB の馬 ID(数値)に保存できないため、一覧(`-U`)から除外します。レース ID を指定した `-S` では除外しないため、指定すると解析に失敗します。
- タイム指数などの指数系の列は、プレミアム会員向けで、未ログインでは `**` になります。`speed_figure` は未ログインのとき `null` です。
- 自動ログインの Cookie は、後続のダウンロードに引き継がれません(Python 版と同じ)。

## ライセンス

MIT License
