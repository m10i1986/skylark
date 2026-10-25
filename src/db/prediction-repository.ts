//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { and, asc, desc, eq, gte, inArray, lt, max, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { payoutKey, type WinPayouts } from "../predict/evaluation.ts";
import { condenseRaceClass, courseOf, type PastRun } from "../predict/form.ts";
import { isValidOdds } from "../predict/market.ts";
import { parseHorseNumbers, type TrifectaResult } from "../predict/trifecta.ts";
import type { RaceRecord, RunnerRecord } from "../predict/types.ts";
import type { Database } from "./crud.ts";
import { uniqueSortedByKey } from "./ordering.ts";
import {
    type BoxProposalRecord,
    boxProposalTable,
    jockeyTable,
    type PredictionModelRecord,
    type PredictionRecord,
    payoffTable,
    predictionModelTable,
    predictionTable,
    raceInfoTable,
    raceResultTable,
} from "./schema.ts";

// IN句に渡す値の数の上限 1回のクエリの引数の数を抑える
const IN_LIST_CHUNK_SIZE = 500;

/** 単勝の券種(util.ts の TICKET_TYPES の添字) */
const WIN_TICKET_TYPE = 0;

/** 三連単の券種(util.ts の TICKET_TYPES の添字) */
export const TRIFECTA_TICKET_TYPE = 8;

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

/** Boxの提案と その後に確定した3連単を突き合わせた1レース分 */
export type BoxProposalWithResult = {
    id: number;
    modelId: number;
    raceId: number;
    raceName: string;
    capturedAt: Date;
    source: "ai" | "fallback";
    aiModel: string | null;
    maxTickets: number;
    // 馬番(昇順)
    horseNumbers: number[];
    ticketCount: number;
    hitProbability: number;
    bestHitProbability: number;
    // 点数の上限内で最も的中確率が高いBox AIの選択と比べるための基準
    baselineHorseNumbers: number[];
    baselineHitProbability: number;
    reason: string;
    caution: string | null;
    // 結果が取り込み済みか
    hasResult: boolean;
    // 確定した3連単(着順どおりの馬番と100円あたりの払戻) 同着では複数 未取り込みや払戻の無いレースは空
    winningTickets: TrifectaResult[];
};

/** 発走前に取得した分が無く 報告の対象から外れたレース */
export type ExcludedRace = {
    raceId: number;
    raceName: string;
};

// 発走の時点(日本時間) レース情報か発走時刻が無い場合はnull
const POST_INSTANT = sql`((${raceInfoTable.date} + ${raceInfoTable.postTime}) at time zone 'Asia/Tokyo')`;

// 発走前に取得した分 発走時刻が分からない場合は取得時刻で絞らない
// 発走後のオッズは確定値で 抽出や提案の条件を事後に知った値で評価してしまうため 検証には使わない
function capturedBeforePost(capturedAt: AnyPgColumn): SQL {
    return sql`(${POST_INSTANT} is null or ${capturedAt} < ${POST_INSTANT})`;
}

// 払戻表の馬番「3->5->8」を馬番の配列にする 形式が違う場合はnull
function parseTrifectaCombination(text: string): number[] | null {
    const parts = text.split("->");
    if (parts.length !== 3 || !parts.every((part) => /^\d{1,2}$/.test(part))) {
        return null;
    }
    return parts.map(Number);
}

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
     * 馬ごとの過去の出走を 指定日より前の分だけ読み込む
     *
     * 開催日が beforeDate 以降のレースは含めない(当日や結果が出た後のレースの結果を混ぜないため)
     * 出走頭数と上がりの順位は そのレースの全出走馬から求める
     *
     * @param horseIds - 馬の識別子
     * @param beforeDate - この開催日より前(YYYY-MM-DD)
     * @returns 馬の識別子から 出走(新しい順)への対応 出走が無い馬は含まない
     */
    async loadHorseRuns(horseIds: readonly number[], beforeDate: string): Promise<Map<number, PastRun[]>> {
        const ids = [...new Set(horseIds)];
        const runsByHorse = new Map<number, PastRun[]>();
        if (ids.length === 0) {
            return runsByHorse;
        }

        const rows = await this.db
            .select({
                horseId: raceResultTable.horseId,
                raceId: raceResultTable.raceId,
                date: raceInfoTable.date,
                raceName: raceInfoTable.raceName,
                placeDetail: raceInfoTable.placeDetail,
                raceClass: raceInfoTable.raceClass,
                trackSurface: raceInfoTable.trackSurface,
                distance: raceInfoTable.distance,
                trackCondition: raceInfoTable.trackCondition,
                orderOfFinish: raceResultTable.orderOfFinish,
                popularity: raceResultTable.popularity,
                odds: raceResultTable.odds,
                margin: raceResultTable.margin,
                finishingTime: raceResultTable.finishingTime,
                lastPhase: raceResultTable.lastPhase,
                passingRank: raceResultTable.passingRank,
                jockeyName: jockeyTable.jockeyName,
                basisWeight: raceResultTable.basisWeight,
                horseWeight: raceResultTable.horseWeight,
                horseWeightDiff: raceResultTable.horseWeightDiff,
            })
            .from(raceResultTable)
            .innerJoin(raceInfoTable, eq(raceResultTable.raceId, raceInfoTable.id))
            .leftJoin(jockeyTable, eq(jockeyTable.id, raceResultTable.jockeyId))
            .where(and(inArray(raceResultTable.horseId, ids), lt(raceInfoTable.date, beforeDate)))
            .orderBy(asc(raceResultTable.horseId), desc(raceInfoTable.date), desc(raceResultTable.raceId));

        const fields = await this.loadFieldStatistics([...new Set(rows.map((row) => row.raceId))]);
        for (const row of rows) {
            const field = fields.get(row.raceId);
            const run: PastRun = {
                raceId: row.raceId,
                date: row.date,
                raceName: row.raceName,
                course: courseOf(row.placeDetail),
                raceClass: condenseRaceClass(row.raceClass),
                trackSurface: row.trackSurface,
                distance: row.distance,
                trackCondition: row.trackCondition,
                fieldSize: field?.fieldSize ?? 0,
                orderOfFinish: row.orderOfFinish,
                popularity: row.popularity,
                odds: row.odds,
                margin: row.margin,
                finishingTime: row.finishingTime,
                lastPhase: row.lastPhase,
                lastPhaseRank:
                    row.lastPhase == null || field == null
                        ? null
                        : 1 + field.lastPhases.filter((other) => other < (row.lastPhase ?? 0)).length,
                passingRank: row.passingRank,
                jockeyName: row.jockeyName,
                basisWeight: row.basisWeight,
                horseWeight: row.horseWeight,
                horseWeightDiff: row.horseWeightDiff,
            };
            const runs = runsByHorse.get(row.horseId) ?? [];
            runs.push(run);
            runsByHorse.set(row.horseId, runs);
        }
        return runsByHorse;
    }

    // レースごとの出走頭数(単勝オッズが付いた馬)と 上がり3ハロンのタイム
    private async loadFieldStatistics(
        raceIds: readonly number[],
    ): Promise<Map<number, { fieldSize: number; lastPhases: number[] }>> {
        const fields = new Map<number, { fieldSize: number; lastPhases: number[] }>();
        for (let start = 0; start < raceIds.length; start += IN_LIST_CHUNK_SIZE) {
            const rows = await this.db
                .select({
                    raceId: raceResultTable.raceId,
                    odds: raceResultTable.odds,
                    lastPhase: raceResultTable.lastPhase,
                })
                .from(raceResultTable)
                .where(inArray(raceResultTable.raceId, raceIds.slice(start, start + IN_LIST_CHUNK_SIZE)));
            for (const row of rows) {
                const field = fields.get(row.raceId) ?? { fieldSize: 0, lastPhases: [] };
                field.fieldSize += isValidOdds(row.odds) ? 1 : 0;
                if (row.lastPhase != null) {
                    field.lastPhases.push(row.lastPhase);
                }
                fields.set(row.raceId, field);
            }
        }
        return fields;
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
     * 指定した開催日の予測を レースごとに発走前に取得した最後の分だけ 結果と突き合わせて返す
     *
     * 発走時刻が分からないレース(レース情報が未取り込みなど)は 取得時刻で絞らず最後の取得分を使う
     * 発走後にしか取得していないレースは含めない(listRacesPredictedOnlyAfterPost)
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
            .leftJoin(raceInfoTable, eq(raceInfoTable.id, predictionTable.raceId))
            .where(and(eq(predictionTable.raceDate, raceDate), capturedBeforePost(predictionTable.capturedAt)))
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

    /**
     * 発走後にしか予測を取得していないレース 発走前の予測が無いため listPredictionsWithResults の対象から外れる
     *
     * @param raceDate - 開催日(YYYY-MM-DD)
     * @returns レースIDの昇順のレース
     */
    async listRacesPredictedOnlyAfterPost(raceDate: string): Promise<ExcludedRace[]> {
        const rows = await this.db
            .select({ raceId: predictionTable.raceId, raceName: max(predictionTable.raceName) })
            .from(predictionTable)
            .innerJoin(raceInfoTable, eq(raceInfoTable.id, predictionTable.raceId))
            .where(and(eq(predictionTable.raceDate, raceDate), sql`${raceInfoTable.postTime} is not null`))
            .groupBy(predictionTable.raceId, raceInfoTable.date, raceInfoTable.postTime)
            .having(sql`min(${predictionTable.capturedAt}) >= ${POST_INSTANT}`)
            .orderBy(asc(predictionTable.raceId));
        return rows.map((row) => ({ raceId: row.raceId, raceName: row.raceName ?? "" }));
    }

    /**
     * Boxの提案を保存する
     *
     * @param record - 提案
     */
    async insertBoxProposal(record: BoxProposalRecord): Promise<void> {
        await this.db.insert(boxProposalTable).values(record);
    }

    /**
     * 指定した開催日のBoxの提案を レースごとに発走前の最後の提案だけ 確定した3連単と突き合わせて返す
     *
     * 発走時刻が分からないレースは 取得時刻で絞らず最後の提案を使う
     * 発走後にしか提案していないレースは含めない(listRacesProposedOnlyAfterPost)
     *
     * @param raceDate - 開催日(YYYY-MM-DD)
     * @returns レースIDの昇順の提案
     */
    async listBoxProposalsWithResults(raceDate: string): Promise<BoxProposalWithResult[]> {
        const latest = this.db
            .select({ latestId: max(boxProposalTable.id).as("latest_id") })
            .from(boxProposalTable)
            .leftJoin(raceInfoTable, eq(raceInfoTable.id, boxProposalTable.raceId))
            .where(and(eq(boxProposalTable.raceDate, raceDate), capturedBeforePost(boxProposalTable.capturedAt)))
            .groupBy(boxProposalTable.raceId)
            .as("latest");
        const proposals = await this.db
            .select({ proposal: boxProposalTable })
            .from(boxProposalTable)
            .innerJoin(latest, eq(latest.latestId, boxProposalTable.id))
            .orderBy(asc(boxProposalTable.raceId));
        if (proposals.length === 0) {
            return [];
        }

        const raceIds = proposals.map((row) => row.proposal.raceId);
        const racesWithResult = new Set(
            (
                await this.db
                    .selectDistinct({ raceId: raceResultTable.raceId })
                    .from(raceResultTable)
                    .where(inArray(raceResultTable.raceId, raceIds))
            ).map((row) => row.raceId),
        );
        const payoffRows = await this.db
            .select({ raceId: payoffTable.raceId, horseNumbers: payoffTable.horseNumbers, payoff: payoffTable.payoff })
            .from(payoffTable)
            .where(and(inArray(payoffTable.raceId, raceIds), eq(payoffTable.ticketType, TRIFECTA_TICKET_TYPE)));
        const ticketsByRace = new Map<number, TrifectaResult[]>();
        for (const row of payoffRows) {
            const combination = parseTrifectaCombination(row.horseNumbers);
            if (combination != null) {
                const tickets = ticketsByRace.get(row.raceId) ?? [];
                tickets.push({ horseNumbers: combination, payoff: row.payoff });
                ticketsByRace.set(row.raceId, tickets);
            }
        }

        return proposals.flatMap(({ proposal }) => {
            const horseNumbers = parseHorseNumbers(proposal.horseNumbers);
            const baselineHorseNumbers = parseHorseNumbers(proposal.baselineHorseNumbers);
            // 保存した馬番を読めない行(通常は無い)は 突き合わせずに読み飛ばす
            if (horseNumbers == null || baselineHorseNumbers == null) {
                return [];
            }
            return [
                {
                    id: proposal.id,
                    modelId: proposal.modelId,
                    raceId: proposal.raceId,
                    raceName: proposal.raceName,
                    capturedAt: proposal.capturedAt,
                    source: proposal.source === "ai" ? "ai" : "fallback",
                    aiModel: proposal.aiModel,
                    maxTickets: proposal.maxTickets,
                    horseNumbers,
                    ticketCount: proposal.ticketCount,
                    hitProbability: proposal.hitProbability,
                    bestHitProbability: proposal.bestHitProbability,
                    baselineHorseNumbers,
                    baselineHitProbability: proposal.baselineHitProbability,
                    reason: proposal.reason,
                    caution: proposal.caution,
                    hasResult: racesWithResult.has(proposal.raceId),
                    winningTickets: ticketsByRace.get(proposal.raceId) ?? [],
                } satisfies BoxProposalWithResult,
            ];
        });
    }

    /**
     * 発走後にしかBoxを提案していないレース 発走前の提案が無いため listBoxProposalsWithResults の対象から外れる
     *
     * @param raceDate - 開催日(YYYY-MM-DD)
     * @returns レースIDの昇順のレース
     */
    async listRacesProposedOnlyAfterPost(raceDate: string): Promise<ExcludedRace[]> {
        const rows = await this.db
            .select({ raceId: boxProposalTable.raceId, raceName: max(boxProposalTable.raceName) })
            .from(boxProposalTable)
            .innerJoin(raceInfoTable, eq(raceInfoTable.id, boxProposalTable.raceId))
            .where(and(eq(boxProposalTable.raceDate, raceDate), sql`${raceInfoTable.postTime} is not null`))
            .groupBy(boxProposalTable.raceId, raceInfoTable.date, raceInfoTable.postTime)
            .having(sql`min(${boxProposalTable.capturedAt}) >= ${POST_INSTANT}`)
            .orderBy(asc(boxProposalTable.raceId));
        return rows.map((row) => ({ raceId: row.raceId, raceName: row.raceName ?? "" }));
    }
}
