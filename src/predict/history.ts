//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { isValidOdds } from "./market.ts";
import type { Circuit, RaceRecord, RunnerRecord } from "./types.ts";

// 特徴量は「そのレースより前の開催日」の成績だけから作る 学習と当日の予測で同じ計算を使う

/** 特徴量の名前 featureRows が返す値の並び順と一致する */
export const FEATURE_NAMES = [
    "log_starts",
    "win_rate",
    "top3_rate",
    "recent_finish",
    "recent_last_phase",
    "log_days_since_last",
    "is_debut",
    "surface_aptitude",
    "distance_aptitude",
    "recent_popularity",
    "basis_weight",
    "age",
    "is_filly",
    "is_gelding",
    "jockey_win_rate",
    "trainer_win_rate",
] as const;

// 事前分布 (勝った数 + 事前の勝率 x 重み) / (出走数 + 重み) で出走数が少ない馬の率を平均へ寄せる
const PRIOR_WIN_RATE = 0.075;
const PRIOR_TOP3_RATE = 0.24;
const HORSE_PRIOR_WEIGHT = 3;
const APTITUDE_PRIOR_WEIGHT = 3;
const JOCKEY_TRAINER_PRIOR_WEIGHT = 50;
// 直近の成績を何走ぶん見るか
const RECENT_FINISH_COUNT = 5;
const RECENT_LAST_PHASE_COUNT = 3;
const RECENT_POPULARITY_COUNT = 3;
// 上がりの相対値は 比べる相手が少ないレースでは信頼できないため この頭数以上で求める
const MIN_RUNNERS_FOR_LAST_PHASE = 3;
const MAX_DAYS_SINCE_LAST = 365;
const DISTANCE_BAND_METERS = 200;
const MS_PER_DAY = 86_400_000;

/** 中央競馬の開催場コード(レースIDの5〜6桁目)の最大値 11以上は地方競馬 */
const MAX_JRA_VENUE_CODE = 10;

/**
 * レースIDから競馬の区分を判定する
 *
 * @param raceId - レースID(例: 202605040711 は 2026年 05=東京 04回 07日目 11R)
 * @returns 開催場コードが10以下なら中央 それ以外は地方
 */
export function circuitOfRaceId(raceId: number): Circuit {
    const venueCode = Math.floor(raceId / 1_000_000) % 100;
    return venueCode <= MAX_JRA_VENUE_CODE ? "jra" : "local";
}

/**
 * 単勝オッズが付いた出走馬だけを返す 取消・除外・発売前の馬を除く
 *
 * @param race - レース
 * @returns 出走馬(馬番の並びは元のまま)
 */
export function startersOf(race: RaceRecord): RunnerRecord[] {
    return race.runners.filter((runner) => isValidOdds(runner.odds));
}

type CategoryCounter = { starts: number; top3: number };

type HorseHistory = {
    starts: number;
    wins: number;
    top3: number;
    // 以下は新しいものが後ろ
    recentFinishes: number[];
    recentLastPhases: number[];
    recentPopularities: number[];
    lastDate: string | null;
    bySurface: Map<string, CategoryCounter>;
    byDistanceBand: Map<number, CategoryCounter>;
};

type RateCounter = { rides: number; wins: number };

function createHorseHistory(): HorseHistory {
    return {
        starts: 0,
        wins: 0,
        top3: 0,
        recentFinishes: [],
        recentLastPhases: [],
        recentPopularities: [],
        lastDate: null,
        bySurface: new Map(),
        byDistanceBand: new Map(),
    };
}

function pushRecent(values: number[], value: number, limit: number): void {
    values.push(value);
    if (values.length > limit) {
        values.shift();
    }
}

// 値が少ないときは事前の値へ寄せた平均
function shrunkMean(values: readonly number[], priorValue: number, priorWeight: number): number {
    const total = values.reduce((sum, value) => sum + value, 0);
    return (total + priorValue * priorWeight) / (values.length + priorWeight);
}

function shrunkRate(hits: number, trials: number, priorRate: number, priorWeight: number): number {
    return (hits + priorRate * priorWeight) / (trials + priorWeight);
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const upper = sorted[middle] ?? 0;
    return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
}

function daysBetween(fromDate: string, toDate: string): number {
    return Math.round((Date.parse(toDate) - Date.parse(fromDate)) / MS_PER_DAY);
}

function countOf<K>(counters: Map<K, CategoryCounter>, key: K): CategoryCounter {
    const existing = counters.get(key);
    if (existing != null) {
        return existing;
    }
    const created: CategoryCounter = { starts: 0, top3: 0 };
    counters.set(key, created);
    return created;
}

function distanceBandOf(distance: number | null): number | null {
    return distance == null ? null : Math.round(distance / DISTANCE_BAND_METERS);
}

/**
 * 馬・騎手・調教師の過去の成績を持ち 出走馬の特徴量を計算する
 *
 * レースの結果を反映する applyRace は 開催日の昇順に呼ぶ
 * 同じ開催日のレースは 特徴量を計算し終えてからまとめて反映する(当日の結果を特徴量へ混ぜないため)
 */
export class HistoryState {
    private readonly horses = new Map<number, HorseHistory>();
    private readonly jockeys = new Map<string, RateCounter>();
    private readonly trainers = new Map<string, RateCounter>();
    private latestDate: string | null = null;

    /** 反映済みの最も新しい開催日 まだ何も反映していない場合はnull */
    get latestAppliedDate(): string | null {
        return this.latestDate;
    }

    /**
     * 終わったレースの結果を履歴へ反映する
     *
     * @param race - 結果が確定したレース
     * @throws {RangeError} 反映済みの開催日より古いレースを渡した場合
     */
    applyRace(race: RaceRecord): void {
        if (this.latestDate != null && race.date < this.latestDate) {
            throw new RangeError(`races must be applied in date order: ${race.date} is before ${this.latestDate}`);
        }
        this.latestDate = race.date;

        const starters = startersOf(race);
        const fieldSize = starters.length;
        if (fieldSize === 0) {
            return;
        }
        const lastPhases = starters.flatMap((runner) => (runner.lastPhase == null ? [] : [runner.lastPhase]));
        const medianLastPhase = lastPhases.length >= MIN_RUNNERS_FOR_LAST_PHASE ? median(lastPhases) : null;
        const distanceBand = distanceBandOf(race.distance);

        for (const runner of starters) {
            const isWin = runner.orderOfFinish === 1;
            const isTop3 = runner.orderOfFinish != null && runner.orderOfFinish <= 3;

            const horse = this.horses.get(runner.horseId) ?? createHorseHistory();
            this.horses.set(runner.horseId, horse);
            horse.starts += 1;
            horse.wins += isWin ? 1 : 0;
            horse.top3 += isTop3 ? 1 : 0;
            // 中止・失格など着順が無い出走は最下位として扱う
            pushRecent(
                horse.recentFinishes,
                runner.orderOfFinish == null ? 1 : runner.orderOfFinish / fieldSize,
                RECENT_FINISH_COUNT,
            );
            if (runner.lastPhase != null && medianLastPhase != null) {
                pushRecent(horse.recentLastPhases, runner.lastPhase - medianLastPhase, RECENT_LAST_PHASE_COUNT);
            }
            if (runner.popularity != null) {
                pushRecent(horse.recentPopularities, runner.popularity / fieldSize, RECENT_POPULARITY_COUNT);
            }
            horse.lastDate = race.date;
            if (race.trackSurface != null) {
                const counter = countOf(horse.bySurface, race.trackSurface);
                counter.starts += 1;
                counter.top3 += isTop3 ? 1 : 0;
            }
            if (distanceBand != null) {
                const counter = countOf(horse.byDistanceBand, distanceBand);
                counter.starts += 1;
                counter.top3 += isTop3 ? 1 : 0;
            }

            this.countRide(this.jockeys, runner.jockeyId, isWin);
            this.countRide(this.trainers, runner.trainerId, isWin);
        }
    }

    private countRide(counters: Map<string, RateCounter>, id: string, isWin: boolean): void {
        const counter = counters.get(id) ?? { rides: 0, wins: 0 };
        counter.rides += 1;
        counter.wins += isWin ? 1 : 0;
        counters.set(id, counter);
    }

    /**
     * レースの出走馬ごとの特徴量を計算する
     *
     * @param race - 結果が出る前のレース(当日のレースも含む)
     * @returns startersOf(race) と同じ並びの 出走馬 x FEATURE_NAMES の値
     * @throws {RangeError} 反映済みの履歴にレースの開催日以降のものが含まれる場合(結果の混入を防ぐ)
     */
    featureRows(race: RaceRecord): number[][] {
        if (this.latestDate != null && this.latestDate >= race.date) {
            throw new RangeError(
                `history up to ${this.latestDate} must not reach the race date ${race.date}: results would leak`,
            );
        }
        const distanceBand = distanceBandOf(race.distance);
        return startersOf(race).map((runner) => this.featuresOf(runner, race, distanceBand));
    }

    private featuresOf(runner: RunnerRecord, race: RaceRecord, distanceBand: number | null): number[] {
        const horse = this.horses.get(runner.horseId) ?? createHorseHistory();
        const top3Rate = shrunkRate(horse.top3, horse.starts, PRIOR_TOP3_RATE, HORSE_PRIOR_WEIGHT);

        const aptitude = (counter: CategoryCounter | undefined): number =>
            counter == null ? 0 : shrunkRate(counter.top3, counter.starts, top3Rate, APTITUDE_PRIOR_WEIGHT) - top3Rate;
        const surfaceAptitude = race.trackSurface == null ? 0 : aptitude(horse.bySurface.get(race.trackSurface));
        const distanceAptitude = distanceBand == null ? 0 : aptitude(horse.byDistanceBand.get(distanceBand));

        const daysSinceLast =
            horse.lastDate == null
                ? 0
                : Math.min(Math.max(daysBetween(horse.lastDate, race.date), 0), MAX_DAYS_SINCE_LAST);
        const jockey = this.jockeys.get(runner.jockeyId);
        const trainer = this.trainers.get(runner.trainerId);

        return [
            Math.log1p(horse.starts),
            shrunkRate(horse.wins, horse.starts, PRIOR_WIN_RATE, HORSE_PRIOR_WEIGHT),
            top3Rate,
            shrunkMean(horse.recentFinishes, 0.5, 2),
            shrunkMean(horse.recentLastPhases, 0, 1),
            Math.log1p(daysSinceLast),
            horse.starts === 0 ? 1 : 0,
            surfaceAptitude,
            distanceAptitude,
            shrunkMean(horse.recentPopularities, 0.5, 2),
            runner.basisWeight,
            runner.age,
            runner.sex === "牝" ? 1 : 0,
            runner.sex === "セ" ? 1 : 0,
            shrunkRate(jockey?.wins ?? 0, jockey?.rides ?? 0, PRIOR_WIN_RATE, JOCKEY_TRAINER_PRIOR_WEIGHT),
            shrunkRate(trainer?.wins ?? 0, trainer?.rides ?? 0, PRIOR_WIN_RATE, JOCKEY_TRAINER_PRIOR_WEIGHT),
        ];
    }
}
