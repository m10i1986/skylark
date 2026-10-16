//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import {
    bigint,
    date,
    doublePrecision,
    index,
    integer,
    jsonb,
    pgTable,
    primaryKey,
    text,
    time,
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

export type RaceInfoRecord = typeof raceInfoTable.$inferInsert;
export type HorseRecord = typeof horseTable.$inferInsert;
export type JockeyRecord = typeof jockeyTable.$inferInsert;
export type TrainerRecord = typeof trainerTable.$inferInsert;
export type OwnerRecord = typeof ownerTable.$inferInsert;
export type RaceResultRecord = typeof raceResultTable.$inferInsert;
export type PayoffRecord = typeof payoffTable.$inferInsert;
export type FeatureRecord = typeof featureTable.$inferInsert;

/** 全テーブル名 外部キーの依存が浅い順 */
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
