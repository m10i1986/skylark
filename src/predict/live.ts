//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import type { PredictionRepository } from "../db/prediction-repository.ts";
import type { PredictionRecord } from "../db/schema.ts";
import type { Logger } from "../logger.ts";
import type { HorseEntry, NetkeibaClient, RaceInformation } from "../webui/netkeiba-client.ts";
import { buildHistoryState } from "./dataset.ts";
import { circuitOfRaceId, type HistoryState, startersOf } from "./history.ts";
import { parseModelParameters, probabilitiesOfRace } from "./model.ts";
import { addDays } from "./train.ts";
import type { RaceRecord, RunnerRecord } from "./types.ts";
import { assessRace, type RunnerAssessment, type ValueCriteria } from "./value.ts";

// 年齢・斤量が読み取れなかった場合の代わりの値(中央競馬の出走馬の典型値)
const FALLBACK_AGE = 4;
const FALLBACK_BASIS_WEIGHT = 55;
const BAREI_PATTERN = /^(牡|牝|セ)(\d+)$/;
// 最新の結果が当日のこの日数より前だと 前日までの成績が反映されていない可能性を知らせる
const STALE_HISTORY_DAYS = 1;
const FETCH_CONCURRENCY = 2;

/**
 * 日付を「YYYY-MM-DD」(ローカル時間)の文字列にする
 *
 * @param date - 日時
 * @returns 日付
 */
export function formatLocalDate(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
}

// 「4回 東京 7日目」のような開催の表記から 回数と日目を除いた会場名を取り出す
const VENUE_EXCLUDED_PATTERN = /^\d+(回|日目)$/;

/**
 * 同じ名前のレースが同日に複数あっても見分けられる 会場とレース番号を付けたレース名を作る
 *
 * @param courseName - 一覧の開催の表記(例: 「4回 東京 7日目」)
 * @param raceNumber - 一覧のレース番号(例: 「11R」)
 * @param raceName - レース名
 * @returns 例: 「東京11R ブラジルC」 会場が読み取れない場合はレース番号とレース名
 */
export function formatRaceLabel(courseName: string, raceNumber: string, raceName: string): string {
    const venue = courseName
        .split(/\s+/)
        .filter((token) => token !== "" && !VENUE_EXCLUDED_PATTERN.test(token))
        .join("");
    return `${venue}${raceNumber.trim()} ${raceName}`.trim();
}

/** 予測結果の出走馬1頭 */
export type PredictedRunner = RunnerAssessment & {
    horseId: number | null;
    horseName: string | null;
};

/** 1レースの予測 */
export type RacePrediction = {
    raceId: number;
    date: string;
    // 会場とレース番号を付けたレース名(formatRaceLabel)
    raceName: string;
    // 発走時刻(HH:MM) 取得できない場合はnull 保存はしない
    postTime: string | null;
    // オッズを取得した時刻
    capturedAt: Date;
    // 人気順に並べた出走馬
    runners: PredictedRunner[];
};

function toRunnerRecord(horse: HorseEntry, horseNumber: number, logger: Logger): RunnerRecord {
    const barei = BAREI_PATTERN.exec(horse.barei ?? "");
    if (barei == null) {
        logger.warning(`unreadable sex/age "${horse.barei ?? ""}" of horse ${horseNumber}: using the fallback`);
    }
    if (horse.horseId == null) {
        logger.warning(`horse ${horseNumber} has no id: its past results are not used`);
    }
    return {
        horseNumber,
        // 識別子が読めない馬は 他の馬の履歴と混ざらないよう馬番から作る負の値にする
        horseId: horse.horseId ?? -horseNumber,
        jockeyId: horse.jockeyId ?? "",
        trainerId: horse.trainerId ?? "",
        sex: barei?.[1] ?? "",
        age: barei?.[2] == null ? FALLBACK_AGE : Number(barei[2]),
        basisWeight: horse.basisWeight ?? FALLBACK_BASIS_WEIGHT,
        orderOfFinish: null,
        lastPhase: null,
        odds: horse.odds,
        popularity: horse.popularity == null ? null : Math.round(horse.popularity),
    };
}

/**
 * 出馬表を 過去のレースと同じ形のレースに変換する
 *
 * @param information - 出馬表サイトから取得したレース
 * @param date - 開催日(YYYY-MM-DD)
 * @param logger - ロガー
 * @returns 結果が出る前のレース
 */
export function toRaceRecord(information: RaceInformation, date: string, logger: Logger): RaceRecord {
    const runners: RunnerRecord[] = [];
    for (const horse of information.horses) {
        if (horse.horseNumber != null) {
            runners.push(toRunnerRecord(horse, horse.horseNumber, logger));
        }
    }
    return {
        raceId: information.race.id,
        date,
        distance: information.race.distance ?? null,
        trackSurface: information.race.trackSurface ?? null,
        runners,
    };
}

/**
 * 1レースの出走馬を評価する
 *
 * @param race - 結果が出る前のレース
 * @param raceName - レース名
 * @param horseNames - 馬番から馬名への対応
 * @param state - 開催日より前の結果だけを反映した履歴
 * @param parameters - 学習済みモデル(parseModelParametersの戻り値)
 * @param criteria - 抽出条件
 * @param capturedAt - オッズを取得した時刻
 * @param postTime - 発走時刻(HH:MM) 不明な場合はnull
 * @returns 予測 単勝オッズが付いた馬が2頭未満(発売前など)の場合は null
 */
export function predictRace(
    race: RaceRecord,
    raceName: string,
    horseNames: ReadonlyMap<number, string>,
    state: HistoryState,
    parameters: ReturnType<typeof parseModelParameters>,
    criteria: ValueCriteria,
    capturedAt: Date,
    postTime: string | null = null,
): RacePrediction | null {
    const starters = startersOf(race);
    if (starters.length < 2) {
        return null;
    }
    const odds = starters.map((runner) => runner.odds ?? 0);
    const probabilities = probabilitiesOfRace(parameters, state.featureRows(race), odds);
    const assessments = assessRace(
        {
            horseNumbers: starters.map((runner) => runner.horseNumber),
            odds,
            popularities: starters.map((runner) => runner.popularity),
            marketProbabilities: probabilities.market,
            modelProbabilities: probabilities.model,
        },
        criteria,
    );
    const runners = assessments
        .map((assessment, index): PredictedRunner => {
            const starter = starters[index];
            return {
                ...assessment,
                horseId: starter != null && starter.horseId > 0 ? starter.horseId : null,
                horseName: horseNames.get(assessment.horseNumber) ?? null,
            };
        })
        .sort((a, b) => a.popularity - b.popularity || a.horseNumber - b.horseNumber);
    return { raceId: race.raceId, date: race.date, raceName, postTime, capturedAt, runners };
}

/** 当日予測が使う外部とのやり取り */
export type PredictTodayDependencies = {
    client: NetkeibaClient;
    repository: PredictionRepository;
    logger: Logger;
    now: () => Date;
};

/** 当日予測の設定 */
export type PredictTodayOptions = {
    criteria: ValueCriteria;
    // この開催日以降の結果を履歴に使う
    historySince: string;
    // 指定した場合は このレースIDだけを予測する
    raceIds: readonly number[];
};

/** 当日予測の結果 */
export type PredictTodayResult = {
    date: string;
    modelId: number;
    predictions: RacePrediction[];
    // オッズが無い(発売前)などで予測できなかったレースID
    skippedRaceIds: number[];
};

/**
 * 当日開催の中央競馬のレースについて 勝率を見積もり 市場(オッズ・人気)と比べて予測を保存する
 *
 * 履歴は当日より前の結果だけを使う 予測は取得時のオッズとともに PostgreSQL へ残す
 *
 * @param dependencies - 出馬表の取得・DB・ロガー・現在時刻
 * @param options - 設定
 * @returns 予測
 * @throws {Error} 学習済みモデルが無い または当日の開催が無い場合
 */
export async function predictToday(
    dependencies: PredictTodayDependencies,
    options: PredictTodayOptions,
): Promise<PredictTodayResult> {
    const { client, repository, logger } = dependencies;
    const today = formatLocalDate(dependencies.now());

    const modelRecord = await repository.getLatestModel("jra");
    if (modelRecord == null) {
        throw new Error("no trained model: run with --train first");
    }
    const parameters = parseModelParameters(modelRecord.parametersJson);

    const history = await repository.loadRaceRecords(options.historySince, today);
    const state = buildHistoryState(history);
    const latest = state.latestAppliedDate;
    if (latest == null) {
        throw new Error(`no past results since ${options.historySince}: run with -U -S first`);
    }
    logger.info(`history: ${history.length} races up to ${latest}, model #${modelRecord.id}`);
    if (latest < addDays(today, -STALE_HISTORY_DAYS)) {
        logger.warning(`the latest result is ${latest}: import recent results with -U -S for better accuracy`);
    }

    const dates = await client.fetchRaceDates(today);
    const todayDate = dates.find((date) => date.kaisaiDate === today);
    if (todayDate == null) {
        throw new Error(`no races are held on ${today}`);
    }
    const listed = (await client.fetchRaceList(todayDate.href)).filter(
        (race) => race.raceId != null && circuitOfRaceId(race.raceId) === "jra",
    );
    const targets =
        options.raceIds.length === 0
            ? listed
            : listed.filter((race) => race.raceId != null && options.raceIds.includes(race.raceId));
    for (const raceId of options.raceIds) {
        if (!listed.some((race) => race.raceId === raceId)) {
            logger.warning(`race ${raceId} is not among the central races held on ${today}: skipped`);
        }
    }
    logger.info(`races to predict: ${targets.length}`);

    // 出馬表サイトへの負荷を抑えるため 同時に取得するレース数を絞る
    const predictions: RacePrediction[] = [];
    const skippedRaceIds: number[] = [];
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
        while (nextIndex < targets.length) {
            const target = targets[nextIndex++];
            if (target?.raceId == null) {
                continue;
            }
            try {
                const information = await client.fetchRaceInformation(target.raceId);
                const capturedAt = dependencies.now();
                const race = toRaceRecord(information, today, logger);
                const horseNames = new Map<number, string>();
                for (const horse of information.horses) {
                    if (horse.horseNumber != null && horse.horseName != null) {
                        horseNames.set(horse.horseNumber, horse.horseName);
                    }
                }
                const prediction = predictRace(
                    race,
                    formatRaceLabel(target.courseName, target.raceNumber, information.race.raceName ?? target.raceName),
                    horseNames,
                    state,
                    parameters,
                    options.criteria,
                    capturedAt,
                    information.race.postTime ?? null,
                );
                if (prediction == null) {
                    logger.warning(`race ${target.raceId}: no win odds yet, skipped`);
                    skippedRaceIds.push(target.raceId);
                } else {
                    predictions.push(prediction);
                }
            } catch (error) {
                logger.error(`failed to predict race ${target.raceId}`, error);
                skippedRaceIds.push(target.raceId);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, targets.length) }, () => worker()));
    predictions.sort((a, b) => a.raceId - b.raceId);

    await repository.insertPredictions(
        predictions.flatMap((prediction) => toPredictionRecords(prediction, modelRecord.id)),
    );
    return { date: today, modelId: modelRecord.id, predictions, skippedRaceIds };
}

/**
 * 予測を保存用のレコードに変換する
 *
 * @param prediction - 1レースの予測
 * @param modelId - 予測に使ったモデルのID
 * @returns 出走馬ごとのレコード
 */
export function toPredictionRecords(prediction: RacePrediction, modelId: number): PredictionRecord[] {
    return prediction.runners.map((runner) => ({
        modelId,
        raceId: prediction.raceId,
        horseNumber: runner.horseNumber,
        capturedAt: prediction.capturedAt,
        raceDate: prediction.date,
        raceName: prediction.raceName,
        horseId: runner.horseId,
        horseName: runner.horseName,
        odds: runner.odds,
        popularity: runner.popularity,
        marketProbability: runner.marketProbability,
        modelProbability: runner.modelProbability,
        modelRank: runner.modelRank,
        expectedValue: runner.expectedValue,
        isValuePick: runner.isValuePick,
    }));
}
