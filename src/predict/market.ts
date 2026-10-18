//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

/**
 * 単勝オッズとして使える値か判定する 取消・除外はオッズが無く 発売前は「---」でnullになる
 *
 * @param value - オッズ
 * @returns 1以上の有限の値ならtrue
 */
export function isValidOdds(value: number | null | undefined): value is number {
    return value != null && Number.isFinite(value) && value >= 1;
}

/**
 * 単勝オッズから 控除率を除いた市場の勝率を求める
 *
 * 各馬の 1/オッズ は控除(払戻率は約80%)のため合計が1を超える 合計で割って合計を1にそろえる
 *
 * @param odds - レース内の全出走馬の単勝オッズ(1以上の有限の値 1.0は元返し)
 * @returns 出走馬ごとの市場の勝率 合計は1
 * @throws {RangeError} オッズが空 または 1未満や有限でない値を含む場合
 */
export function marketProbabilities(odds: readonly number[]): number[] {
    if (odds.length === 0) {
        throw new RangeError("odds must not be empty");
    }
    const inverses = odds.map((value) => {
        if (!isValidOdds(value)) {
            throw new RangeError(`odds must be a finite number of at least 1: ${value}`);
        }
        return 1 / value;
    });
    const total = inverses.reduce((sum, value) => sum + value, 0);
    return inverses.map((value) => value / total);
}

/**
 * オッズの低い順に人気の順位を付ける 同じオッズは同じ順位
 *
 * @param odds - レース内の全出走馬の単勝オッズ
 * @returns 出走馬ごとの順位(1が最も人気)
 */
export function popularityRanksFromOdds(odds: readonly number[]): number[] {
    return odds.map((value) => 1 + odds.filter((other) => other < value).length);
}

/**
 * 勝率の高い順に順位を付ける 同じ勝率は同じ順位
 *
 * @param probabilities - 出走馬ごとの勝率
 * @returns 出走馬ごとの順位(1が最も高い)
 */
export function ranksDescending(probabilities: readonly number[]): number[] {
    return probabilities.map((value) => 1 + probabilities.filter((other) => other > value).length);
}
