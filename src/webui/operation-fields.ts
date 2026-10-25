//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

// 操作画面のフォームの項目 サーバーの検証(operation-form.ts)と画面(operations-views.tsx)の両方が使う
// ブラウザへ配信されるため Node.js 専用のモジュールは読み込まない

import { DEFAULT_BOX_MAX_TICKETS, MAX_BOX_HORSES, MIN_BOX_HORSES, maxBoxHorseCount } from "../predict/trifecta.ts";

/** チェック欄の項目名 チェックされると値は FLAG_ON になる */
export const FLAG_FIELDS = [
    "rebuildAllTables",
    "confirmRebuildAllTables",
    "rebuildFeature",
    "confirmRebuildFeature",
    "updateRaceList",
    "scraping",
    "feature",
    "train",
    "predict",
    "aiBox",
    "report",
    "verbose",
    "debug",
] as const;

/** 入力欄の項目名 */
export const TEXT_FIELDS = [
    "periodOfMonths",
    "raceListFile",
    "raceIds",
    "date",
    "historySince",
    "minOdds",
    "minPopularity",
    "maxRank",
    "minEv",
    "boxHorses",
] as const;

export type FlagField = (typeof FLAG_FIELDS)[number];
export type TextField = (typeof TEXT_FIELDS)[number];

/** フォームから受け取った値 未入力の項目は持たない */
export type OperationFormValues = Partial<Record<FlagField | TextField, string>>;

/** チェックされた欄の値 */
export const FLAG_ON = "1";

/** 一度に指定できるレースIDの数 */
export const MAX_RACE_IDS = 500;

/** 一覧を遡る月数の範囲 範囲を設けるのは netkeiba.com へのアクセス数が際限なく増えないようにするため */
export const MIN_PERIOD_MONTHS = 1;
export const MAX_PERIOD_MONTHS = 240;

/** 1行の入力欄に入れられる文字数 */
export const MAX_FIELD_CHARS = 64;

/** レースIDの入力欄に入れられる文字数 */
export const MAX_RACE_IDS_CHARS = 20_000;

/** Boxの頭数の選択肢(3〜8頭) */
export const BOX_HORSES_CHOICES: readonly number[] = Array.from(
    { length: MAX_BOX_HORSES - MIN_BOX_HORSES + 1 },
    (_, index) => MIN_BOX_HORSES + index,
);

/** Boxの頭数を選ばない(AIにまかせる)場合の最大の頭数 コマンドラインの点数の上限(--box-max-tickets)の既定値に収まる最大の頭数 */
export const AUTO_BOX_MAX_HORSES = maxBoxHorseCount(DEFAULT_BOX_MAX_TICKETS, MAX_BOX_HORSES);

/** 入力欄の初期値として見せる コマンドラインの既定値 */
export type OperationDefaults = {
    periodOfMonths: number;
    raceListFile: string;
    historySince: string;
    minOdds: number;
    minPopularity: number;
    maxRank: number;
    minExpectedValue: number;
    // HTMLキャッシュの置き場 画面からは変更できない
    tempDirectory: string;
};
