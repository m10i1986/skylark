//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import {
    bigint,
    boolean,
    date,
    doublePrecision,
    index,
    integer,
    jsonb,
    pgTable,
    primaryKey,
    text,
    time,
    timestamp,
    varchar,
} from "drizzle-orm/pg-core";

// ORM テーブル定義 識別子は18桁未満のため bigint は number で扱う

/** レース情報 */
export const raceInfoTable = pgTable(
    "race_info_tbl",
    {
        id: bigint("id", { mode: "number" }).primaryKey(),
        raceName: varchar("race_name", { length: 256 }).notNull(),
        date: date("date", { mode: "string" }).notNull(),
        postTime: time("post_time"),
        distance: integer("distance"),
        weather: varchar("weather", { length: 8 }),
        raceNumber: bigint("race_number", { mode: "number" }).notNull(),
        runDirection: varchar("run_direction", { length: 8 }),
        trackSurface: varchar("track_surface", { length: 8 }),
        trackCondition: varchar("track_condition", { length: 8 }),
        trackConditionScore: integer("track_condition_score"),
        placeDetail: varchar("place_detail", { length: 16 }).notNull(),
        raceGrade: integer("race_grade"),
        raceClass: varchar("race_class", { length: 64 }),
    },
    (table) => [index("idx_race_name").on(table.raceName), index("idx_date_post_time").on(table.date, table.postTime)],
);

/** 馬 */
export const horseTable = pgTable("horse_tbl", {
    id: bigint("id", { mode: "number" }).primaryKey(),
    horseName: varchar("horse_name", { length: 256 }).notNull(),
});

/** 騎手 識別子は先頭の0を保つため文字列 */
export const jockeyTable = pgTable("jockey_tbl", {
    id: varchar("id", { length: 32 }).primaryKey(),
    jockeyName: varchar("jockey_name", { length: 256 }).notNull(),
});

/** 調教師 識別子は先頭の0を保つため文字列 */
export const trainerTable = pgTable("trainer_tbl", {
    id: varchar("id", { length: 32 }).primaryKey(),
    trainerName: varchar("trainer_name", { length: 256 }).notNull(),
});

/** 馬主 識別子は先頭の0を保つため文字列 */
export const ownerTable = pgTable("owner_tbl", {
    id: varchar("id", { length: 32 }).primaryKey(),
    ownerName: varchar("owner_name", { length: 256 }).notNull(),
});

/** レース結果 */
export const raceResultTable = pgTable(
    "race_result_tbl",
    {
        raceId: bigint("race_id", { mode: "number" })
            .notNull()
            .references(() => raceInfoTable.id),
        horseNumber: integer("horse_number").notNull(),
        orderOfFinish: integer("order_of_finish"),
        bracketNumber: integer("bracket_number").notNull(),
        horseId: bigint("horse_id", { mode: "number" })
            .notNull()
            .references(() => horseTable.id),
        sex: varchar("sex", { length: 8 }).notNull(),
        age: integer("age").notNull(),
        basisWeight: doublePrecision("basis_weight").notNull(),
        jockeyId: varchar("jockey_id", { length: 32 }).notNull(),
        finishingTime: time("finishing_time"),
        margin: varchar("margin", { length: 16 }).notNull(),
        speedFigure: integer("speed_figure"),
        passingRank: varchar("passing_rank", { length: 16 }).notNull(),
        lastPhase: doublePrecision("last_phase"),
        odds: doublePrecision("odds"),
        popularity: integer("popularity"),
        horseWeight: integer("horse_weight"),
        horseWeightDiff: integer("horse_weight_diff"),
        remark: text("remark"),
        stable: varchar("stable", { length: 8 }).notNull(),
        trainerId: varchar("trainer_id", { length: 32 }).notNull(),
        ownerId: varchar("owner_id", { length: 32 }).notNull(),
        earningMoney: doublePrecision("earning_money"),
    },
    (table) => [
        primaryKey({ columns: [table.raceId, table.horseNumber] }),
        // MySQLは外部キー列へ自動でインデックスを作るがPostgreSQLは作らない 馬ごとの過去成績検索に必要
        index("idx_horse_id").on(table.horseId),
        index("idx_race_horse").on(table.raceId, table.horseId),
        index("idx_race_jockey").on(table.raceId, table.jockeyId),
        index("idx_race_trainer").on(table.raceId, table.trainerId),
        index("idx_race_owner").on(table.raceId, table.ownerId),
    ],
);

/** 払戻 */
export const payoffTable = pgTable(
    "payoff_tbl",
    {
        raceId: bigint("race_id", { mode: "number" })
            .notNull()
            .references(() => raceInfoTable.id),
        ticketType: integer("ticket_type").notNull(),
        horseNumbers: varchar("horse_numbers", { length: 16 }).notNull(),
        payoff: integer("payoff").notNull(),
        popularity: integer("popularity").notNull(),
    },
    (table) => [primaryKey({ columns: [table.raceId, table.ticketType, table.horseNumbers] })],
);

/** 特徴量 計算結果はjsonbで保持する */
export const featureTable = pgTable(
    "feature_tbl",
    {
        horseId: bigint("horse_id", { mode: "number" })
            .notNull()
            .references(() => horseTable.id),
        raceId: bigint("race_id", { mode: "number" })
            .notNull()
            .references(() => raceInfoTable.id),
        jockeyId: varchar("jockey_id", { length: 32 }).notNull(),
        trainerId: varchar("trainer_id", { length: 32 }).notNull(),
        calculationResultJson: jsonb("calculation_result_json"),
    },
    (table) => [primaryKey({ columns: [table.horseId, table.raceId] })],
);

/** 予測モデル 係数と評価指標はjsonbで保持する 学習のたびに行が増え 最新の行を使う */
export const predictionModelTable = pgTable("prediction_model_tbl", {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    // 学習の対象とした競馬の区分(jra=中央)
    circuit: varchar("circuit", { length: 8 }).notNull(),
    // 学習・検証・テスト期間の開始日と、データの最終日
    trainFrom: date("train_from", { mode: "string" }).notNull(),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    testFrom: date("test_from", { mode: "string" }).notNull(),
    dataTo: date("data_to", { mode: "string" }).notNull(),
    parametersJson: jsonb("parameters_json").notNull(),
    metricsJson: jsonb("metrics_json").notNull(),
});

/**
 * 予測 1回の実行(オッズの取得時刻)ごとのスナップショット
 *
 * 当日のレースはレース情報の保管前に予測するため レース情報や馬への外部キーは持たない
 * 取得時のオッズは後から復元できないため この表の値を残す
 */
export const predictionTable = pgTable(
    "prediction_tbl",
    {
        modelId: integer("model_id")
            .notNull()
            .references(() => predictionModelTable.id),
        raceId: bigint("race_id", { mode: "number" }).notNull(),
        horseNumber: integer("horse_number").notNull(),
        // オッズを取得した時刻
        capturedAt: timestamp("captured_at", { withTimezone: true, mode: "date" }).notNull(),
        raceDate: date("race_date", { mode: "string" }).notNull(),
        raceName: varchar("race_name", { length: 256 }).notNull(),
        horseId: bigint("horse_id", { mode: "number" }),
        horseName: varchar("horse_name", { length: 256 }),
        odds: doublePrecision("odds").notNull(),
        popularity: integer("popularity"),
        // 控除率を除いたレース内の市場の勝率
        marketProbability: doublePrecision("market_probability").notNull(),
        // モデルが見積もった勝率
        modelProbability: doublePrecision("model_probability").notNull(),
        // レース内でのモデル勝率の順位(1が最上位)
        modelRank: integer("model_rank").notNull(),
        // 単勝100円あたりの期待払戻倍率(モデル勝率 x オッズ) 1を超えると市場より割安
        expectedValue: doublePrecision("expected_value").notNull(),
        isValuePick: boolean("is_value_pick").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.raceId, table.horseNumber, table.capturedAt] }),
        index("idx_prediction_race_date").on(table.raceDate),
    ],
);

/**
 * 3連単Boxの提案 AIが選んだ(AIを使えず切り替えた場合は的中確率が最も高い)Boxを 勝率の元にしたオッズの取得時刻とともに残す
 *
 * 確定後に実際の3連単の払戻と突き合わせるための記録(--report) 提案は再現できないため prediction_tbl と同じく
 * レース情報や馬への外部キーは持たない 馬番は昇順に「-」でつないだ文字列(例: 1-3-5-8)で保存する
 */
export const boxProposalTable = pgTable(
    "box_proposal_tbl",
    {
        id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
        // 勝率の見積もりに使ったモデル
        modelId: integer("model_id")
            .notNull()
            .references(() => predictionModelTable.id),
        raceId: bigint("race_id", { mode: "number" }).notNull(),
        // 勝率の元にしたオッズを取得した時刻 prediction_tbl の captured_at と一致する
        capturedAt: timestamp("captured_at", { withTimezone: true, mode: "date" }).notNull(),
        raceDate: date("race_date", { mode: "string" }).notNull(),
        raceName: varchar("race_name", { length: 256 }).notNull(),
        // ai=AIの選択 fallback=AIを使えず的中確率が最も高いBoxに切り替えた
        source: varchar("source", { length: 8 }).notNull(),
        // 応答したモデル fallback の場合はnull
        aiModel: varchar("ai_model", { length: 64 }),
        // 提案時の点数の上限
        maxTickets: integer("max_tickets").notNull(),
        horseNumbers: varchar("horse_numbers", { length: 32 }).notNull(),
        ticketCount: integer("ticket_count").notNull(),
        // Harville式で求めた的中確率
        hitProbability: doublePrecision("hit_probability").notNull(),
        // 同じ頭数で最も的中確率が高いBoxの的中確率
        bestHitProbability: doublePrecision("best_hit_probability").notNull(),
        // 点数の上限内で最も的中確率が高いBox AIの選択と比べるための基準
        baselineHorseNumbers: varchar("baseline_horse_numbers", { length: 32 }).notNull(),
        baselineHitProbability: doublePrecision("baseline_hit_probability").notNull(),
        reason: text("reason").notNull(),
        caution: text("caution"),
    },
    (table) => [
        index("idx_box_proposal_race_date").on(table.raceDate),
        index("idx_box_proposal_race").on(table.raceId),
    ],
);

export type RaceInfoRecord = typeof raceInfoTable.$inferInsert;
export type HorseRecord = typeof horseTable.$inferInsert;
export type JockeyRecord = typeof jockeyTable.$inferInsert;
export type TrainerRecord = typeof trainerTable.$inferInsert;
export type OwnerRecord = typeof ownerTable.$inferInsert;
export type RaceResultRecord = typeof raceResultTable.$inferInsert;
export type PayoffRecord = typeof payoffTable.$inferInsert;
export type FeatureRecord = typeof featureTable.$inferInsert;
export type PredictionModelRecord = typeof predictionModelTable.$inferSelect;
export type PredictionRecord = typeof predictionTable.$inferInsert;
export type BoxProposalRecord = typeof boxProposalTable.$inferInsert;

/**
 * スクレイピング結果の全テーブル名 外部キーの依存が浅い順
 *
 * 予測モデルと予測とBoxの提案(prediction_model_tbl, prediction_tbl, box_proposal_tbl)は含めない
 * 予測と提案は取得時のオッズを残した記録で 再スクレイピングでは復元できないため --rebuild-all-tables の対象にしない
 */
export const ALL_TABLE_NAMES = [
    "race_info_tbl",
    "horse_tbl",
    "jockey_tbl",
    "trainer_tbl",
    "owner_tbl",
    "race_result_tbl",
    "payoff_tbl",
    "feature_tbl",
] as const;

export type TableName = (typeof ALL_TABLE_NAMES)[number];
