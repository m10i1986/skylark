//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

// 券種の並び順 添字がそのままDBの ticket_type 値になる
const TICKET_TYPES: readonly string[] = ["単勝", "複勝", "枠単", "枠連", "馬連", "ワイド", "馬単", "三連複", "三連単"];

// クラスの並び順 添字がそのままDBの race_grade 値になる
const RACE_CLASSES: readonly string[] = ["オープン", "1600万下", "1000万下", "500万下", "未勝利", "新馬"];

/**
 * 券種名をDB保存用の整数へ変換する
 *
 * @param key - 券種名
 * @returns 券種の添字 未知の券種や空入力の場合はnull
 */
export function ticketTypeToInt(key: string | null | undefined): number | null {
    if (key == null || key === "") {
        return null;
    }
    const index = TICKET_TYPES.indexOf(key);
    return index === -1 ? null : index;
}

/**
 * レースクラス名をDB保存用の整数へ変換する
 *
 * 先頭一致は対象外とし 2文字目以降に現れた場合だけ一致とみなす(移植元の仕様)
 *
 * @param key - レースクラスを含む文字列
 * @returns クラスの添字 一致なしや空入力の場合はnull
 */
export function raceClassToInt(key: string | null | undefined): number | null {
    if (key == null || key === "") {
        return null;
    }
    const index = RACE_CLASSES.findIndex((raceClass) => key.indexOf(raceClass) > 0);
    return index === -1 ? null : index;
}
