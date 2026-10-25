//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

// 出走馬の過去走を AI に渡す形にまとめる
// 過去走は 出走するレースの開催日より前の結果だけを使う(結果の混入を防ぐ) 読み込みは prediction-repository.ts が行う

/** 馬の過去の1走 */
export type PastRun = {
    raceId: number;
    // 開催日(YYYY-MM-DD)
    date: string;
    raceName: string;
    // 開催場 読み取れない場合はnull
    course: string | null;
    // 「3歳オープン」のような条件 読み取れない場合はnull
    raceClass: string | null;
    trackSurface: string | null;
    distance: number | null;
    trackCondition: string | null;
    // 単勝オッズが付いた出走頭数
    fieldSize: number;
    // 着順 取消・中止・失格などはnull
    orderOfFinish: number | null;
    popularity: number | null;
    odds: number | null;
    // 着差 1着は空
    margin: string;
    finishingTime: string | null;
    // 上がり3ハロンのタイム(秒)
    lastPhase: number | null;
    // そのレースでの上がりの順位 1が最も速い
    lastPhaseRank: number | null;
    passingRank: string;
    jockeyName: string | null;
    basisWeight: number;
    horseWeight: number | null;
    horseWeightDiff: number | null;
};

/** 出走数と 1着・3着以内の回数 */
export type RecordSummary = {
    starts: number;
    wins: number;
    top3: number;
};

/** 出走馬の過去走のまとめ */
export type HorseForm = {
    // 取り込み済みの全ての出走 DBにある範囲に限る
    career: RecordSummary;
    // 今回と同じ馬場での成績 今回の馬場が分からない場合はnull
    sameSurface: RecordSummary | null;
    // 今回の距離との差が NEAR_DISTANCE_METERS 以内の成績 今回の距離が分からない場合はnull
    nearDistance: RecordSummary | null;
    // これまでに走った最も長い距離 距離の分かる出走が無い場合はnull
    longestDistance: number | null;
    // 前走から今回までの日数 前走が無い場合はnull
    daysSinceLast: number | null;
    // 今回の距離から前走の距離を引いた値(m) 長くなる場合は正 どちらかが分からない場合はnull
    distanceChange: number | null;
    // 直近の出走 新しいものが先頭
    recentRuns: PastRun[];
};

/** 今回のレースの条件 */
export type FormTarget = {
    date: string;
    trackSurface: string | null;
    distance: number | null;
};

/** 同じ距離帯とみなす距離の差(m) */
export const NEAR_DISTANCE_METERS = 200;
/** 詳しく見せる直近の出走数 */
export const RECENT_RUN_COUNT = 5;

const MS_PER_DAY = 86_400_000;

// 条件の表記を 括弧や2つ以上の空白の手前までにする 「3歳オープン  (国際) 牡・牝(指)(馬齢)」は「3歳オープン」になる
const CLASS_END_PATTERN = /\s{2,}|[([（［]/;
// 開催の表記から 回数と日目を除く 「4回阪神7日目」「4回 京都 9日目」は それぞれ「阪神」「京都」になる
const MEETING_COUNT_PATTERN = /\d+(回|日目)/g;

/**
 * 開催の表記から開催場を取り出す
 *
 * @param placeDetail - 開催の表記(例: 4回阪神7日目)
 * @returns 開催場 読み取れない場合はnull
 */
export function courseOf(placeDetail: string): string | null {
    const course = placeDetail.replace(MEETING_COUNT_PATTERN, "").replace(/\s+/g, "");
    return course === "" ? null : course;
}

/**
 * レースの条件の表記を短くする
 *
 * @param raceClass - 条件の表記(例: 3歳オープン  (国際) 牡・牝(指)(馬齢))
 * @returns 括弧などの付記を除いた条件(例: 3歳オープン) 読み取れない場合はnull
 */
export function condenseRaceClass(raceClass: string | null): string | null {
    const condensed = raceClass?.split(CLASS_END_PATTERN)[0]?.trim() ?? "";
    return condensed === "" ? null : condensed;
}

function summarize(runs: readonly PastRun[]): RecordSummary {
    return {
        starts: runs.length,
        wins: runs.filter((run) => run.orderOfFinish === 1).length,
        top3: runs.filter((run) => run.orderOfFinish != null && run.orderOfFinish <= 3).length,
    };
}

function daysBetween(fromDate: string, toDate: string): number {
    return Math.round((Date.parse(toDate) - Date.parse(fromDate)) / MS_PER_DAY);
}

/**
 * 馬の過去走を まとめる
 *
 * @param runs - 馬の過去の出走(新しい順) 今回のレースの開催日より前のものだけを渡す
 * @param target - 今回のレースの条件
 * @param recentCount - 詳しく見せる直近の出走数
 * @returns 過去走のまとめ 出走が無い馬は 出走数0のまとめになる
 */
export function buildHorseForm(
    runs: readonly PastRun[],
    target: FormTarget,
    recentCount: number = RECENT_RUN_COUNT,
): HorseForm {
    const last = runs[0];
    const distances = runs.flatMap((run) => (run.distance == null ? [] : [run.distance]));
    const { trackSurface, distance } = target;
    return {
        career: summarize(runs),
        sameSurface: trackSurface == null ? null : summarize(runs.filter((run) => run.trackSurface === trackSurface)),
        nearDistance:
            distance == null
                ? null
                : summarize(
                      runs.filter(
                          (run) => run.distance != null && Math.abs(run.distance - distance) <= NEAR_DISTANCE_METERS,
                      ),
                  ),
        longestDistance: distances.length === 0 ? null : Math.max(...distances),
        daysSinceLast: last == null ? null : Math.max(daysBetween(last.date, target.date), 0),
        distanceChange: last?.distance == null || distance == null ? null : distance - last.distance,
        recentRuns: runs.slice(0, recentCount),
    };
}
