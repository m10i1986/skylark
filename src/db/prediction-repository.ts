//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { and, asc, desc, eq, gte, lt, max, sql } from "drizzle-orm";

import { payoutKey, type WinPayouts } from "../predict/evaluation.ts";
import type { RaceRecord, RunnerRecord } from "../predict/types.ts";
import type { Database } from "./crud.ts";
import { uniqueSortedByKey } from "./ordering.ts";
import {
    type PredictionModelRecord,
    type PredictionRecord,
    payoffTable,
    predictionModelTable,
    predictionTable,
    raceInfoTable,
    raceResultTable,
} from "./schema.ts";

/** 単勝の券種(util.ts の TICKET_TYPES の添字) */
const WIN_TICKET_TYPE = 0;

/** 保存するモデルの内容 */
export type NewPredictionModel = Pick<
    PredictionModelRecord,
    "circuit" | "trainFrom" | "validFrom" | "testFrom" | "dataTo"
> & {
    parameters: unknown;
    metrics: unknown;
};

/** 予測と その後に確定した結果を突き合わせた1頭分 */
export type PredictionWithResult = {
    modelId: number;
    raceId: number;
    horseNumber: number;
    capturedAt: Date;
    raceName: string;
    horseName: string | null;
    odds: number;
    popularity: number | null;
    marketProbability: number;
    modelProbability: number;
    modelRank: number;
    expectedValue: number;
    isValuePick: boolean;
    // 結果が未取り込みの場合はnull 取消・中止などで着順が無い場合もnull
    orderOfFinish: number | null;
    // 結果が取り込み済みか
    hasResult: boolean;
    // 単勝の払戻(100円あたり) 勝っていない または未取り込みの場合はnull
    winPayoff: number | null;
};

// jsonb列へJSON文字列をそのまま渡すと Bun.SQL が文字列をさらにJSON化して二重にエンコードされるため
// text として受け取りサーバー側で jsonb へ変換する(SkylarkCrud.upsertFeatures と同じ理由)
function jsonbValue(value: unknown) {
    return sql`${JSON.stringify(value)}::text::jsonb`;
}

/** 予測モデルと予測の読み書き */
export class PredictionRepository {
    private readonly db: Database;

    constructor(db: Database) {
        this.db = db;
    }

    /**
     * 指定日以降のレースを 出走馬ごとの結果とともに読み込む
     *
     * @param sinceDate - この開催日以降(YYYY-MM-DD)
     * @param beforeDate - この開催日より前(YYYY-MM-DD) 省略時は上限なし 当日の予測では当日を渡して当日の結果を除く
     * @returns 開催日・レースIDの昇順のレース
     */
    async loadRaceRecords(sinceDate: string, beforeDate?: string): Promise<RaceRecord[]> {
        const rows = await this.db
            .select({
                raceId: raceResultTable.raceId,
                date: raceInfoTable.date,
                distance: raceInfoTable.distance,
                trackSurface: raceInfoTable.trackSurface,
                horseNumber: raceResultTable.horseNumber,
                horseId: raceResultTable.horseId,
                jockeyId: raceResultTable.jockeyId,
                trainerId: raceResultTable.trainerId,
                sex: raceResultTable.sex,
                age: raceResultTable.age,
                basisWeight: raceResultTable.basisWeight,
                orderOfFinish: raceResultTable.orderOfFinish,
                lastPhase: raceResultTable.lastPhase,
                odds: raceResultTable.odds,
                popularity: raceResultTable.popularity,
            })
            .from(raceResultTable)
            .innerJoin(raceInfoTable, eq(raceResultTable.raceId, raceInfoTable.id))
            .where(
                and(
                    gte(raceInfoTable.date, sinceDate),
                    beforeDate == null ? undefined : lt(raceInfoTable.date, beforeDate),
                ),
            )
            .orderBy(asc(raceInfoTable.date), asc(raceResultTable.raceId), asc(raceResultTable.horseNumber));

        const races: RaceRecord[] = [];
        let current: RaceRecord | null = null;
        for (const row of rows) {
            if (current == null || current.raceId !== row.raceId) {
                current = {
                    raceId: row.raceId,
                    date: row.date,
                    distance: row.distance,
                    trackSurface: row.trackSurface,
                    runners: [],
                };
                races.push(current);
            }
            const runner: RunnerRecord = {
                horseNumber: row.horseNumber,
                horseId: row.horseId,
                jockeyId: row.jockeyId,
                trainerId: row.trainerId,
                sex: row.sex,
                age: row.age,
                basisWeight: row.basisWeight,
                orderOfFinish: row.orderOfFinish,
                lastPhase: row.lastPhase,
                odds: row.odds,
                popularity: row.popularity,
            };
            current.runners.push(runner);
        }
        return races;
    }

    /**
     * 期間内のレースの単勝払戻を読み込む
     *
     * @param sinceDate - この開催日以降(YYYY-MM-DD)
     * @returns 馬ごとの払戻(100円あたりの円)
     */
    async loadWinPayouts(sinceDate: string): Promise<WinPayouts> {
        const rows = await this.db
            .select({ raceId: payoffTable.raceId, horseNumbers: payoffTable.horseNumbers, payoff: payoffTable.payoff })
            .from(payoffTable)
            .innerJoin(raceInfoTable, eq(payoffTable.raceId, raceInfoTable.id))
            .where(and(eq(payoffTable.ticketType, WIN_TICKET_TYPE), gte(raceInfoTable.date, sinceDate)));

        const payouts = new Map<string, number>();
        for (const row of rows) {
            // 単勝の組み合わせは馬番1つ それ以外の形式は読み飛ばす
            if (/^\d+$/.test(row.horseNumbers)) {
                payouts.set(payoutKey(row.raceId, Number(row.horseNumbers)), row.payoff);
            }
        }
        return payouts;
    }

    /**
     * 学習したモデルを保存する
     *
     * @param model - 保存するモデル
     * @returns 採番されたモデルID
     */
    async insertModel(model: NewPredictionModel): Promise<number> {
        const rows = await this.db
            .insert(predictionModelTable)
            .values({
                circuit: model.circuit,
                trainFrom: model.trainFrom,
                validFrom: model.validFrom,
                testFrom: model.testFrom,
                dataTo: model.dataTo,
                parametersJson: jsonbValue(model.parameters),
                metricsJson: jsonbValue(model.metrics),
            })
            .returning({ id: predictionModelTable.id });
        const id = rows[0]?.id;
        if (id == null) {
            throw new Error("failed to insert the prediction model");
        }
        return id;
    }

    /**
     * 最新のモデルを返す
     *
     * @param circuit - 競馬の区分
     * @returns 最新のモデル 無い場合はundefined
     */
    async getLatestModel(circuit: string): Promise<PredictionModelRecord | undefined> {
        const rows = await this.db
            .select()
            .from(predictionModelTable)
            .where(eq(predictionModelTable.circuit, circuit))
            .orderBy(desc(predictionModelTable.id))
            .limit(1);
        return rows[0];
    }

    /**
     * 予測を保存する 主キーの昇順に書き込む
     *
     * @param records - 予測
     */
    async insertPredictions(records: PredictionRecord[]): Promise<void> {
        const unique = uniqueSortedByKey(records, (record) => [
            record.raceId,
            record.horseNumber,
            record.capturedAt.getTime(),
        ]);
        if (unique.length === 0) {
            return;
        }
        await this.db.insert(predictionTable).values(unique);
    }

    /**
     * 指定した開催日の予測を レースごとに最新の取得分だけ 結果と突き合わせて返す
     *
     * @param raceDate - 開催日(YYYY-MM-DD)
     * @returns レースID・馬番の昇順の予測
     */
    async listPredictionsWithResults(raceDate: string): Promise<PredictionWithResult[]> {
        const latest = this.db
            .select({
                raceId: predictionTable.raceId,
                capturedAt: max(predictionTable.capturedAt).as("latest_captured_at"),
            })
            .from(predictionTable)
            .where(eq(predictionTable.raceDate, raceDate))
            .groupBy(predictionTable.raceId)
            .as("latest");

        const rows = await this.db
            .select({
                modelId: predictionTable.modelId,
                raceId: predictionTable.raceId,
                horseNumber: predictionTable.horseNumber,
                capturedAt: predictionTable.capturedAt,
                raceName: predictionTable.raceName,
                horseName: predictionTable.horseName,
                odds: predictionTable.odds,
                popularity: predictionTable.popularity,
                marketProbability: predictionTable.marketProbability,
                modelProbability: predictionTable.modelProbability,
                modelRank: predictionTable.modelRank,
                expectedValue: predictionTable.expectedValue,
                isValuePick: predictionTable.isValuePick,
                orderOfFinish: raceResultTable.orderOfFinish,
                resultRaceId: raceResultTable.raceId,
                winPayoff: payoffTable.payoff,
            })
            .from(predictionTable)
            .innerJoin(
                latest,
                and(eq(latest.raceId, predictionTable.raceId), eq(latest.capturedAt, predictionTable.capturedAt)),
            )
            .leftJoin(
                raceResultTable,
                and(
                    eq(raceResultTable.raceId, predictionTable.raceId),
                    eq(raceResultTable.horseNumber, predictionTable.horseNumber),
                ),
            )
            .leftJoin(
                payoffTable,
                and(
                    eq(payoffTable.raceId, predictionTable.raceId),
                    eq(payoffTable.ticketType, WIN_TICKET_TYPE),
                    eq(payoffTable.horseNumbers, sql`${predictionTable.horseNumber}::text`),
                ),
            )
            .orderBy(asc(predictionTable.raceId), asc(predictionTable.horseNumber));

        return rows.map(({ resultRaceId, ...row }) => ({ ...row, hasResult: resultRaceId != null }));
    }
}
