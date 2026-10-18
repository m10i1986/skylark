//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

/** 競馬の区分 jra=中央競馬 local=地方競馬 */
export type Circuit = "jra" | "local";

/** 出走1頭分の情報 過去のレースと当日のレースの両方で同じ形を使う */
export type RunnerRecord = {
    horseNumber: number;
    horseId: number;
    // 騎手と調教師の識別子は先頭の0を保つため文字列
    jockeyId: string;
    trainerId: string;
    sex: string;
    age: number;
    basisWeight: number;
    // 着順 取消・除外・中止・失格はnull 当日のレースでは常にnull
    orderOfFinish: number | null;
    // 上がり3ハロンのタイム(秒)
    lastPhase: number | null;
    // 単勝オッズ 取消・除外は発売されないためnull
    odds: number | null;
    popularity: number | null;
};

/** 1レース分の情報 */
export type RaceRecord = {
    raceId: number;
    // 開催日(YYYY-MM-DD)
    date: string;
    distance: number | null;
    trackSurface: string | null;
    runners: RunnerRecord[];
};

/** 学習と評価に使う1レース分 出走馬は単勝オッズが付いた馬だけ(取消・除外を除く) */
export type RaceSample = {
    raceId: number;
    date: string;
    circuit: Circuit;
    horseNumbers: number[];
    // 出走馬 x 特徴量(標準化前)
    features: number[][];
    odds: number[];
    // 人気 取得できない場合はnull
    popularities: Array<number | null>;
    // 1着の馬か 同着の場合は複数
    isWinners: boolean[];
};
