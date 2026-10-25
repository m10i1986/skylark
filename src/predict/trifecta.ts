//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

// 3連単Boxの的中確率を 各馬の勝率から求める
// 着順の確率は Harville 式で近似する 1着の馬を除いた残りの勝率を正規化して 2着 3着の確率を決める
//   P(i, j, k) = p_i x p_j / (1 - p_i) x p_k / (1 - p_i - p_j)
// 実際の着順は Harville 式の仮定(強い馬ほど上位に偏る)から外れるため 的中確率は目安であり 3連単のオッズは使っていない

/** 3連単の1点の購入額(円) */
export const TICKET_PRICE_YEN = 100;

/** Boxの頭数の下限 3頭未満では3連単の組み合わせが作れない */
export const MIN_BOX_HORSES = 3;

/** Boxの頭数の上限 8頭は336点(33,600円)で それ以上は買い方として現実的でない */
export const MAX_BOX_HORSES = 8;

/** Boxの点数の上限の既定値 5頭ボックス(60点 6,000円) */
export const DEFAULT_BOX_MAX_TICKETS = 60;

// 勝率の上位だけを候補の母集団にする 全頭から選ぶと18頭立てで8頭Boxの組み合わせが4万を超えるため 計算量を抑える
// 勝率が13位以下の馬が最良のBoxに入ることは現実にはない
const CANDIDATE_POOL_SIZE = 12;

/** Boxの候補 */
export type BoxCandidate = {
    // 馬番(昇順)
    horseNumbers: number[];
    ticketCount: number;
    costYen: number;
    // Harville式で求めた的中確率 Box内の3頭が着順を問わず1〜3着を占める確率
    hitProbability: number;
};

/**
 * n頭のBoxの点数を求める
 *
 * @param horseCount - 頭数
 * @returns 点数 n x (n-1) x (n-2) 3頭未満は0
 */
export function boxTicketCount(horseCount: number): number {
    return horseCount < MIN_BOX_HORSES ? 0 : horseCount * (horseCount - 1) * (horseCount - 2);
}

/**
 * 点数の上限に収まる最大の頭数を求める
 *
 * @param maxTickets - 点数の上限
 * @param runnerCount - 出走頭数
 * @returns 頭数 3頭のBoxも作れない場合は0
 */
export function maxBoxHorseCount(maxTickets: number, runnerCount: number): number {
    let count = 0;
    for (let horses = MIN_BOX_HORSES; horses <= Math.min(MAX_BOX_HORSES, runnerCount); horses++) {
        if (boxTicketCount(horses) > maxTickets) {
            break;
        }
        count = horses;
    }
    return count;
}

/**
 * Boxの的中確率を求める 3頭を問わず Box内の馬だけで1〜3着が決まる確率
 *
 * Box内の全ての順列(3連単の全点)について Harville式の確率を足し合わせる
 *
 * @param probabilities - 出走馬ごとの勝率(合計1)
 * @param members - Boxに入れる馬の添字(probabilitiesの添字)
 * @returns 的中確率
 * @throws {RangeError} 添字が範囲外 または重複している場合
 */
export function boxHitProbability(probabilities: readonly number[], members: readonly number[]): number {
    const unique = new Set(members);
    if (unique.size !== members.length) {
        throw new RangeError("box members must not contain duplicates");
    }
    for (const member of members) {
        if (!Number.isInteger(member) || member < 0 || member >= probabilities.length) {
            throw new RangeError(`box member is out of range: ${member}`);
        }
    }
    const probabilityOf = (index: number): number => probabilities[index] ?? 0;

    let total = 0;
    for (const first of members) {
        const firstProbability = probabilityOf(first);
        const restAfterFirst = 1 - firstProbability;
        if (restAfterFirst <= 0) {
            continue;
        }
        for (const second of members) {
            if (second === first) {
                continue;
            }
            const secondProbability = probabilityOf(second);
            const restAfterSecond = restAfterFirst - secondProbability;
            if (restAfterSecond <= 0) {
                continue;
            }
            for (const third of members) {
                if (third === first || third === second) {
                    continue;
                }
                total +=
                    firstProbability * (secondProbability / restAfterFirst) * (probabilityOf(third) / restAfterSecond);
            }
        }
    }
    return total;
}

// 候補を的中確率の高い順 同じなら馬番の小さい順に並べる
function compareCandidates(a: BoxCandidate, b: BoxCandidate): number {
    if (a.hitProbability !== b.hitProbability) {
        return b.hitProbability - a.hitProbability;
    }
    for (let index = 0; index < a.horseNumbers.length; index++) {
        const difference = (a.horseNumbers[index] ?? 0) - (b.horseNumbers[index] ?? 0);
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
}

// poolの中からcount個を選ぶ全ての組み合わせ(添字の昇順)に対してvisitを呼ぶ
function forEachCombination(poolSize: number, count: number, visit: (indices: readonly number[]) => void): void {
    const chosen: number[] = [];
    const extend = (start: number): void => {
        if (chosen.length === count) {
            visit(chosen);
            return;
        }
        for (let index = start; index <= poolSize - (count - chosen.length); index++) {
            chosen.push(index);
            extend(index + 1);
            chosen.pop();
        }
    };
    extend(0);
}

/** 候補を探す条件 */
export type CandidateOptions = {
    // 点数の上限
    maxTickets: number;
    // 頭数ごとに残す候補の数
    perSize: number;
};

/**
 * 頭数ごとに的中確率の高いBoxの候補を求める
 *
 * @param horseNumbers - 出走馬の馬番
 * @param probabilities - 出走馬ごとの勝率(horseNumbersと同じ並び 合計1)
 * @param options - 点数の上限と 頭数ごとに残す候補の数
 * @returns 頭数の少ない順 同じ頭数の中では的中確率の高い順 点数の上限で3頭も作れない場合は空
 * @throws {RangeError} 馬番と勝率の長さが違う または候補の数が1未満の場合
 */
export function candidateBoxes(
    horseNumbers: readonly number[],
    probabilities: readonly number[],
    options: CandidateOptions,
): BoxCandidate[] {
    if (horseNumbers.length !== probabilities.length) {
        throw new RangeError("horse numbers and probabilities must have the same length");
    }
    if (!Number.isInteger(options.perSize) || options.perSize < 1) {
        throw new RangeError("perSize must be a positive integer");
    }
    const largest = maxBoxHorseCount(options.maxTickets, horseNumbers.length);
    if (largest === 0) {
        return [];
    }

    // 勝率の高い順(同じなら馬番の小さい順)に母集団を絞る
    const pool = horseNumbers
        .map((horseNumber, index) => ({ horseNumber, index, probability: probabilities[index] ?? 0 }))
        .sort((a, b) => b.probability - a.probability || a.horseNumber - b.horseNumber)
        .slice(0, CANDIDATE_POOL_SIZE);

    const candidates: BoxCandidate[] = [];
    for (let horses = MIN_BOX_HORSES; horses <= Math.min(largest, pool.length); horses++) {
        const kept: BoxCandidate[] = [];
        forEachCombination(pool.length, horses, (indices) => {
            const members = indices.map((poolIndex) => pool[poolIndex]);
            const candidate: BoxCandidate = {
                horseNumbers: members.map((member) => member?.horseNumber ?? 0).sort((a, b) => a - b),
                ticketCount: boxTicketCount(horses),
                costYen: boxTicketCount(horses) * TICKET_PRICE_YEN,
                hitProbability: boxHitProbability(
                    probabilities,
                    members.map((member) => member?.index ?? 0),
                ),
            };
            // 上位perSize件だけを保つ
            const worst = kept[kept.length - 1];
            if (worst == null || kept.length < options.perSize || compareCandidates(candidate, worst) < 0) {
                kept.push(candidate);
                kept.sort(compareCandidates);
                if (kept.length > options.perSize) {
                    kept.pop();
                }
            }
        });
        candidates.push(...kept);
    }
    return candidates;
}

/**
 * 馬番を指定したBoxの的中確率を求める
 *
 * @param horseNumbers - 出走馬の馬番
 * @param probabilities - 出走馬ごとの勝率(horseNumbersと同じ並び 合計1)
 * @param boxHorseNumbers - Boxに入れる馬の馬番
 * @returns 的中確率
 * @throws {RangeError} 出走馬にない馬番を含む または重複している場合
 */
export function boxHitProbabilityByNumbers(
    horseNumbers: readonly number[],
    probabilities: readonly number[],
    boxHorseNumbers: readonly number[],
): number {
    const members = boxHorseNumbers.map((horseNumber) => {
        const index = horseNumbers.indexOf(horseNumber);
        if (index === -1) {
            throw new RangeError(`horse number is not a starter: ${horseNumber}`);
        }
        return index;
    });
    return boxHitProbability(probabilities, members);
}

/** 確定した3連単の1点 着順どおりの馬番と 100円あたりの払戻(円) */
export type TrifectaResult = {
    horseNumbers: readonly number[];
    payoff: number;
};

/**
 * 確定した3連単に対する Box の払戻を求める
 *
 * Boxは着順を問わず全ての順列を買うため 確定した3頭がBoxに全て含まれれば1点が的中する
 * 同着で確定した組み合わせが複数ある場合は それぞれの払戻を足す
 *
 * @param boxHorseNumbers - Boxの馬番
 * @param results - 確定した3連単(払戻は100円あたり)
 * @returns 払戻の合計(1点100円ずつ買った場合の円) 的中しなければ0
 */
export function boxPayoff(boxHorseNumbers: readonly number[], results: readonly TrifectaResult[]): number {
    const box = new Set(boxHorseNumbers);
    return results.reduce(
        (sum, result) =>
            result.horseNumbers.length === MIN_BOX_HORSES && result.horseNumbers.every((number) => box.has(number))
                ? sum + result.payoff
                : sum,
        0,
    );
}

/**
 * 馬番を保存用の文字列にする
 *
 * @param horseNumbers - 馬番
 * @returns 昇順に「-」でつないだ文字列(例: 1-3-5)
 */
export function formatHorseNumbers(horseNumbers: readonly number[]): string {
    return [...horseNumbers].sort((a, b) => a - b).join("-");
}

/**
 * 保存用の文字列を馬番に戻す
 *
 * @param text - 「-」でつないだ馬番(例: 1-3-5)
 * @returns 馬番 形式が違う場合はnull
 */
export function parseHorseNumbers(text: string): number[] | null {
    const parts = text.split("-");
    if (!parts.every((part) => /^\d{1,2}$/.test(part))) {
        return null;
    }
    return parts.map(Number);
}
