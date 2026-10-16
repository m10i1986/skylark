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
bun run webui
```

`scraper.sh` と `webui.sh` は、それぞれ上の `cli.ts` と Web UI を起動するだけの短いスクリプトです。

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
| `src/webui/` | Web UI(Hono + Playwright) |
| `drizzle/` | マイグレーション SQL(自動生成) |
| `tests/` | テスト |

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

netkeiba.com のページ構成が、元の実装を書いた時点から変わっています。次の点は、Python 版から引き継いだ問題です。
(レース番号の表記が「1 R」から「1R」に変わった点だけは、どちらの表記でも解析できるようにしてあります。)

- レース一覧の更新(`-U`)が参照する `https://db.netkeiba.com/?pid=race_top` は、現在エラー文だけを返します。
- 現在のレース結果ページは、結果表の列が増えて(21 列 → 25 列)います。位置で列を決める解析は、新しいページを解析できません。キャッシュ済みの旧形式のページは、これまでどおり解析できます。
- 自動ログインの Cookie は、後続のダウンロードに引き継がれません(Python 版と同じ)。

## ライセンス

MIT License
