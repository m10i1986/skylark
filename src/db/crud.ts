//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { and, asc, between, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { describeError, type Logger } from "../logger.ts";
import type { RaceSink } from "../scraper/race-scraper.ts";
import { uniqueSortedByKey } from "./ordering.ts";
import type * as schema from "./schema.ts";
import {
    ALL_TABLE_NAMES,
    type FeatureRecord,
    featureTable,
    type HorseRecord,
    horseTable,
    type JockeyRecord,
    jockeyTable,
    type OwnerRecord,
    ownerTable,
    type PayoffRecord,
    payoffTable,
    type RaceInfoRecord,
    type RaceResultRecord,
    raceInfoTable,
    raceResultTable,
    type TableName,
    type TrainerRecord,
    trainerTable,
} from "./schema.ts";

/** リポジトリが扱うデータベース Bun.SQL版とPGlite版(テスト用)の両方を受け付ける */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/** 特徴量の計算対象となる出走1頭分の情報 */
export type FeatureTarget = {
    raceId: number;
    horseNumber: number;
    horseId: number;
    jockeyId: string;
    trainerId: string;
    // 開催日(YYYY-MM-DD)
    date: string;
    distance: number | null;
};

/**
 * データベースへの読み書きをまとめたリポジトリ
 *
 * 参照系は失敗してもログへ記録して undefined を返す(移植元の仕様) 書き込み系は例外を呼び出し元へ伝える
 * 平均値を返すメソッドは精度を保つため PostgreSQL の数値をそのまま10進文字列で返す
 */
export class SkylarkCrud implements RaceSink {
    private readonly db: Database;
    private readonly logger: Logger;

    constructor(db: Database, logger: Logger) {
        this.db = db;
        this.logger = logger;
    }

    // 参照系の共通処理 失敗はログへ記録して undefined にする
    private async safely<T>(query: () => Promise<T>): Promise<T | undefined> {
        try {
            return await query();
        } catch (error) {
            this.logger.error(describeError(error));
            return undefined;
        }
    }

    /**
     * 全テーブルの行を削除する
     *
     * テーブル定義はマイグレーションが管理するため DROP ではなく TRUNCATE で空にする
     */
    async truncateAllTables(): Promise<void> {
        const tables = ALL_TABLE_NAMES.map((name) => `"${name}"`).join(", ");
        await this.db.execute(sql.raw(`TRUNCATE TABLE ${tables} CASCADE`));
    }

    /**
     * 指定テーブルの行を削除する
     *
     * @param tableName - 削除対象のテーブル名
     */
    async truncateTable(tableName: TableName): Promise<void> {
        await this.db.execute(sql.raw(`TRUNCATE TABLE "${tableName}"`));
    }

    async getHorse(horseId: number) {
        return this.safely(async () => {
            const rows = await this.db.select().from(horseTable).where(eq(horseTable.id, horseId)).limit(1);
            return rows[0];
        });
    }

    async getHorseId(raceId: number, horseNumber: number): Promise<number | undefined> {
        assertPositive(raceId, horseNumber);
        return this.safely(async () => {
            const rows = await this.db
                .select({ value: raceResultTable.horseId })
                .from(raceResultTable)
                .where(and(eq(raceResultTable.raceId, raceId), eq(raceResultTable.horseNumber, horseNumber)))
                .limit(1);
            return rows[0]?.value;
        });
    }

    async insertHorses(records: HorseRecord[]): Promise<void> {
        if (records.length === 0) {
            return;
        }
        await this.db
            .insert(horseTable)
            .values(uniqueSortedByKey(records, (record) => [record.id]))
            .onConflictDoNothing();
    }

    async getJockey(jockeyId: string) {
        return this.safely(async () => {
            const rows = await this.db.select().from(jockeyTable).where(eq(jockeyTable.id, jockeyId)).limit(1);
            return rows[0];
        });
    }

    async getJockeyId(raceId: number, horseNumber: number): Promise<string | undefined> {
        assertPositive(raceId, horseNumber);
        return this.safely(async () => {
            const rows = await this.db
                .select({ value: raceResultTable.jockeyId })
                .from(raceResultTable)
                .where(and(eq(raceResultTable.raceId, raceId), eq(raceResultTable.horseNumber, horseNumber)))
                .limit(1);
            return rows[0]?.value;
        });
    }

    async insertJockeys(records: JockeyRecord[]): Promise<void> {
        if (records.length === 0) {
            return;
        }
        await this.db
            .insert(jockeyTable)
            .values(uniqueSortedByKey(records, (record) => [record.id]))
            .onConflictDoNothing();
    }

    async getTrainer(trainerId: string) {
        return this.safely(async () => {
            const rows = await this.db.select().from(trainerTable).where(eq(trainerTable.id, trainerId)).limit(1);
            return rows[0];
        });
    }

    async getTrainerId(raceId: number, horseNumber: number): Promise<string | undefined> {
        assertPositive(raceId, horseNumber);
        return this.safely(async () => {
            const rows = await this.db
                .select({ value: raceResultTable.trainerId })
                .from(raceResultTable)
                .where(and(eq(raceResultTable.raceId, raceId), eq(raceResultTable.horseNumber, horseNumber)))
                .limit(1);
            return rows[0]?.value;
        });
    }

    async insertTrainers(records: TrainerRecord[]): Promise<void> {
        if (records.length === 0) {
            return;
        }
        await this.db
            .insert(trainerTable)
            .values(uniqueSortedByKey(records, (record) => [record.id]))
            .onConflictDoNothing();
    }

    async getOwner(ownerId: string) {
        return this.safely(async () => {
            const rows = await this.db.select().from(ownerTable).where(eq(ownerTable.id, ownerId)).limit(1);
            return rows[0];
        });
    }

    async getOwnerId(raceId: number, horseNumber: number): Promise<string | undefined> {
        assertPositive(raceId, horseNumber);
        return this.safely(async () => {
            const rows = await this.db
                .select({ value: raceResultTable.ownerId })
                .from(raceResultTable)
                .where(and(eq(raceResultTable.raceId, raceId), eq(raceResultTable.horseNumber, horseNumber)))
                .limit(1);
            return rows[0]?.value;
        });
    }

    async insertOwners(records: OwnerRecord[]): Promise<void> {
        if (records.length === 0) {
            return;
        }
        await this.db
            .insert(ownerTable)
            .values(uniqueSortedByKey(records, (record) => [record.id]))
            .onConflictDoNothing();
    }

    async getRaceInfo(raceId: number) {
        return this.safely(async () => {
            const rows = await this.db.select().from(raceInfoTable).where(eq(raceInfoTable.id, raceId)).limit(1);
            return rows[0];
        });
    }

    async insertRaceInfo(record: RaceInfoRecord): Promise<void> {
        await this.db.insert(raceInfoTable).values(record).onConflictDoNothing();
    }

    async getRaceResults() {
        return this.safely(() =>
            this.db
                .select()
                .from(raceResultTable)
                .orderBy(asc(raceResultTable.raceId), asc(raceResultTable.horseNumber)),
        );
    }

    async getRaceResult(raceId: number, horseNumber: number) {
        return this.safely(async () => {
            const rows = await this.db
                .select()
                .from(raceResultTable)
                .where(and(eq(raceResultTable.raceId, raceId), eq(raceResultTable.horseNumber, horseNumber)))
                .limit(1);
            return rows[0];
        });
    }

    async insertRaceResults(records: RaceResultRecord[]): Promise<void> {
        if (records.length === 0) {
            return;
        }
        await this.db
            .insert(raceResultTable)
            .values(uniqueSortedByKey(records, (record) => [record.raceId, record.horseNumber]))
            .onConflictDoNothing();
    }

    async getOrderOfFinish(raceId: number, horseNumber: number): Promise<number | null | undefined> {
        assertPositive(raceId, horseNumber);
        return this.safely(async () => {
            const rows = await this.db
                .select({ value: raceResultTable.orderOfFinish })
                .from(raceResultTable)
                .where(and(eq(raceResultTable.raceId, raceId), eq(raceResultTable.horseNumber, horseNumber)))
                .limit(1);
            return rows[0]?.value;
        });
    }

    async insertPayoffs(records: PayoffRecord[]): Promise<void> {
        if (records.length === 0) {
            return;
        }
        await this.db
            .insert(payoffTable)
            .values(uniqueSortedByKey(records, (record) => [record.raceId, record.ticketType, record.horseNumbers]))
            .onConflictDoNothing();
    }

    /**
     * 特徴量を登録する 主キー(horseId, raceId)が重複する場合は更新する
     *
     * 同じ主キーが入力内に複数ある場合は後ろの値を採用する 並行実行でもデッドロックしないよう主キー順に書き込む
     *
     * @param records - 登録する特徴量
     */
    async upsertFeatures(records: FeatureRecord[]): Promise<void> {
        const unique = uniqueSortedByKey(records, (record) => [record.horseId, record.raceId], "last");
        if (unique.length === 0) {
            return;
        }
        // jsonb列へJSON文字列をそのまま渡すと Bun.SQL が文字列をさらにJSON化して二重にエンコードされる
        // text として受け取りサーバー側で jsonb へ変換すれば ドライバの型推論に依存しない
        const values = unique.map((record) => ({
            ...record,
            calculationResultJson:
                record.calculationResultJson == null
                    ? null
                    : sql`${JSON.stringify(record.calculationResultJson)}::text::jsonb`,
        }));
        await this.db
            .insert(featureTable)
            .values(values)
            .onConflictDoUpdate({
                target: [featureTable.horseId, featureTable.raceId],
                set: {
                    jockeyId: sql`excluded.jockey_id`,
                    trainerId: sql`excluded.trainer_id`,
                    calculationResultJson: sql`excluded.calculation_result_json`,
                },
            });
    }

    /**
     * 特徴量の計算対象(全出走馬)を レース情報と結合して取得する
     *
     * @returns レースID 馬番の昇順の一覧 失敗時は undefined
     */
    async listFeatureTargets(): Promise<FeatureTarget[] | undefined> {
        return this.safely(() =>
            this.db
                .select({
                    raceId: raceResultTable.raceId,
                    horseNumber: raceResultTable.horseNumber,
                    horseId: raceResultTable.horseId,
                    jockeyId: raceResultTable.jockeyId,
                    trainerId: raceResultTable.trainerId,
                    date: raceInfoTable.date,
                    distance: raceInfoTable.distance,
                })
                .from(raceResultTable)
                .innerJoin(raceInfoTable, eq(raceResultTable.raceId, raceInfoTable.id))
                .orderBy(asc(raceResultTable.raceId), asc(raceResultTable.horseNumber)),
        );
    }

    /**
     * 直近のタイム指数を返す
     *
     * @param horseId - 馬ID
     * @param date - この日付より前のレースだけを対象とする(YYYY-MM-DD)
     * @returns タイム指数 該当なしの場合は undefined
     */
    async getSpeedFigureLast(horseId: number, date: string): Promise<number | undefined> {
        assertPositive(horseId);
        return this.safely(async () => {
            const rows = await this.db
                .select({ value: raceResultTable.speedFigure })
                .from(raceResultTable)
                .innerJoin(raceInfoTable, eq(raceResultTable.raceId, raceInfoTable.id))
                .where(
                    and(
                        eq(raceResultTable.horseId, horseId),
                        lt(raceInfoTable.date, date),
                        isNotNull(raceResultTable.speedFigure),
                    ),
                )
                .orderBy(desc(raceInfoTable.date))
                .limit(1);
            return rows[0]?.value ?? undefined;
        });
    }

    /**
     * 直近 limit 件のタイム指数の平均を返す
     *
     * @param horseId - 馬ID
     * @param date - この日付より前のレースだけを対象とする(YYYY-MM-DD)
     * @param limit - 対象とする件数
     * @returns 10進文字列の平均値 該当なしの場合は undefined
     */
    async getSpeedFigureAvg(horseId: number, date: string, limit: number): Promise<string | undefined> {
        assertPositive(horseId, limit);
        return this.safely(async () => {
            const recent = this.db
                .select({ value: raceResultTable.speedFigure })
                .from(raceResultTable)
                .innerJoin(raceInfoTable, eq(raceResultTable.raceId, raceInfoTable.id))
                .where(
                    and(
                        eq(raceResultTable.horseId, horseId),
                        lt(raceInfoTable.date, date),
                        isNotNull(raceResultTable.speedFigure),
                    ),
                )
                .orderBy(desc(raceInfoTable.date))
                .limit(limit)
                .as("recent");
            const rows = await this.db.select({ value: sql<string | null>`avg(${recent.value})::text` }).from(recent);
            return rows[0]?.value ?? undefined;
        });
    }

    /**
     * 直近 limit 件のうち3着以内の着順の平均を返す
     *
     * @param horseId - 馬ID
     * @param date - この日付より前のレースだけを対象とする(YYYY-MM-DD)
     * @param limit - 対象とする件数
     * @returns 10進文字列の平均値 該当なしの場合は undefined
     */
    async getWinnerAvg(horseId: number, date: string, limit: number): Promise<string | undefined> {
        assertPositive(horseId, limit);
        return this.safely(async () => {
            const recent = this.db
                .select({ value: raceResultTable.orderOfFinish })
                .from(raceResultTable)
                .innerJoin(raceInfoTable, eq(raceResultTable.raceId, raceInfoTable.id))
                .where(
                    and(
                        eq(raceResultTable.horseId, horseId),
                        between(raceResultTable.orderOfFinish, 1, 3),
                        lt(raceInfoTable.date, date),
                        isNotNull(raceResultTable.speedFigure),
                    ),
                )
                .orderBy(desc(raceInfoTable.date))
                .limit(limit)
                .as("recent");
            const rows = await this.db.select({ value: sql<string | null>`avg(${recent.value})::text` }).from(recent);
            return rows[0]?.value ?? undefined;
        });
    }

    /**
     * 同じ距離のレースにおける 直近 limit 件のタイム指数の平均を返す
     *
     * @param horseId - 馬ID
     * @param date - この日付より前のレースだけを対象とする(YYYY-MM-DD)
     * @param distance - 距離(m)
     * @param limit - 対象とする件数
     * @returns 10進文字列の平均値 該当なしの場合は undefined
     */
    async getDisavesr(horseId: number, date: string, distance: number, limit: number): Promise<string | undefined> {
        assertPositive(horseId, distance, limit);
        return this.safely(async () => {
            const recent = this.db
                .select({ value: raceResultTable.speedFigure })
                .from(raceResultTable)
                .innerJoin(raceInfoTable, eq(raceResultTable.raceId, raceInfoTable.id))
                .where(
                    and(
                        eq(raceResultTable.horseId, horseId),
                        lt(raceInfoTable.date, date),
                        eq(raceInfoTable.distance, distance),
                        isNotNull(raceResultTable.speedFigure),
                    ),
                )
                .orderBy(desc(raceInfoTable.date))
                .limit(limit)
                .as("recent");
            const rows = await this.db.select({ value: sql<string | null>`avg(${recent.value})::text` }).from(recent);
            return rows[0]?.value ?? undefined;
        });
    }

    /**
     * 直近 limit 件のレース距離の平均を返す
     *
     * @param horseId - 馬ID
     * @param date - この日付より前のレースだけを対象とする(YYYY-MM-DD)
     * @param limit - 対象とする件数
     * @returns 10進文字列の平均値 該当なしの場合は undefined
     */
    async getDistanceAvg(horseId: number, date: string, limit: number): Promise<string | undefined> {
        assertPositive(horseId, limit);
        return this.safely(async () => {
            const recent = this.db
                .select({ value: raceInfoTable.distance })
                .from(raceInfoTable)
                .innerJoin(raceResultTable, eq(raceInfoTable.id, raceResultTable.raceId))
                .where(and(eq(raceResultTable.horseId, horseId), lt(raceInfoTable.date, date)))
                .orderBy(desc(raceInfoTable.date))
                .limit(limit)
                .as("recent");
            const rows = await this.db.select({ value: sql<string | null>`avg(${recent.value})::text` }).from(recent);
            return rows[0]?.value ?? undefined;
        });
    }

    /**
     * 直近 limit 件の賞金の平均を返す
     *
     * @param horseId - 馬ID
     * @param date - この日付より前のレースだけを対象とする(YYYY-MM-DD)
     * @param limit - 対象とする件数
     * @returns 10進文字列の平均値 該当なしの場合は undefined
     */
    async getEarningsPerShare(horseId: number, date: string, limit: number): Promise<string | undefined> {
        assertPositive(horseId, limit);
        return this.safely(async () => {
            const recent = this.db
                .select({ value: raceResultTable.earningMoney })
                .from(raceResultTable)
                .innerJoin(raceInfoTable, eq(raceResultTable.raceId, raceInfoTable.id))
                .where(and(eq(raceResultTable.horseId, horseId), lt(raceInfoTable.date, date)))
                .orderBy(desc(raceInfoTable.date))
                .limit(limit)
                .as("recent");
            const rows = await this.db.select({ value: sql<string | null>`avg(${recent.value})::text` }).from(recent);
            return rows[0]?.value ?? undefined;
        });
    }
}

// 移植元の assert に相当する前提条件の検査
function assertPositive(...values: number[]): void {
    for (const value of values) {
        if (!(value > 0)) {
            throw new RangeError(`value must be greater than zero: ${value}`);
        }
    }
}
