//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import {
    alternativeBoxes,
    boxHitProbability,
    boxHitProbabilityByNumbers,
    boxPayoff,
    boxTicketCount,
    candidateBoxes,
    DEFAULT_BOX_MAX_TICKETS,
    formatHorseNumbers,
    MAX_BOX_HORSES,
    maxBoxHorseCount,
    parseHorseNumbers,
} from "../src/predict/trifecta.ts";

// 合計1になる勝率を作る(重みを正規化する)
function normalized(weights: readonly number[]): number[] {
    const total = weights.reduce((sum, value) => sum + value, 0);
    return weights.map((value) => value / total);
}

// 全順列を使った独立な実装 3頭の順列をHarville式で一つずつ足す
function bruteForceHitProbability(probabilities: readonly number[], members: readonly number[]): number {
    let total = 0;
    for (const a of members) {
        for (const b of members) {
            for (const c of members) {
                if (a === b || b === c || a === c) {
                    continue;
                }
                const pa = probabilities[a] ?? 0;
                const pb = probabilities[b] ?? 0;
                const pc = probabilities[c] ?? 0;
                total += pa * (pb / (1 - pa)) * (pc / (1 - pa - pb));
            }
        }
    }
    return total;
}

describe("boxTicketCount", () => {
    test("頭数ごとの点数は n x (n-1) x (n-2)", () => {
        expect([3, 4, 5, 6, 7, 8].map(boxTicketCount)).toEqual([6, 24, 60, 120, 210, 336]);
    });

    test("3頭未満は0点", () => {
        expect([0, 1, 2].map(boxTicketCount)).toEqual([0, 0, 0]);
    });
});

describe("maxBoxHorseCount", () => {
    test("点数の上限に収まる最大の頭数を返す", () => {
        expect(maxBoxHorseCount(DEFAULT_BOX_MAX_TICKETS, 16)).toBe(5);
        expect(maxBoxHorseCount(24, 16)).toBe(4);
        expect(maxBoxHorseCount(59, 16)).toBe(4);
        expect(maxBoxHorseCount(120, 16)).toBe(6);
    });

    test("出走頭数を超えない", () => {
        expect(maxBoxHorseCount(DEFAULT_BOX_MAX_TICKETS, 4)).toBe(4);
        expect(maxBoxHorseCount(DEFAULT_BOX_MAX_TICKETS, 3)).toBe(3);
    });

    test("8頭より大きくしない", () => {
        expect(maxBoxHorseCount(100_000, 18)).toBe(MAX_BOX_HORSES);
    });

    test("3頭のBoxも作れない場合は0", () => {
        expect(maxBoxHorseCount(5, 16)).toBe(0);
        expect(maxBoxHorseCount(DEFAULT_BOX_MAX_TICKETS, 2)).toBe(0);
    });
});

describe("boxHitProbability", () => {
    test("4頭立ての3頭Boxは手計算の値と一致する", () => {
        // p = [0.4, 0.3, 0.2, 0.1] 馬0 馬1 馬2 の6通りを足す
        //   0→1→2 = 0.4 x 0.3/0.6 x 0.2/0.3 = 0.133333   0→2→1 = 0.4 x 0.2/0.6 x 0.3/0.4 = 0.1
        //   1→0→2 = 0.3 x 0.4/0.7 x 0.2/0.3 = 0.114286   1→2→0 = 0.3 x 0.2/0.7 x 0.4/0.5 = 0.068571
        //   2→0→1 = 0.2 x 0.4/0.8 x 0.3/0.4 = 0.075      2→1→0 = 0.2 x 0.3/0.8 x 0.4/0.5 = 0.06
        expect(boxHitProbability([0.4, 0.3, 0.2, 0.1], [0, 1, 2])).toBeCloseTo(0.55119, 5);
    });

    test("3頭立ての全頭Boxは必ず的中する", () => {
        expect(boxHitProbability([0.5, 0.3, 0.2], [0, 1, 2])).toBeCloseTo(1, 12);
    });

    test("全出走馬を入れたBoxの的中確率は1になる", () => {
        for (const runnerCount of [3, 4, 5, 9, 18]) {
            const probabilities = normalized(Array.from({ length: runnerCount }, (_, index) => (index + 1) ** 1.5));
            const all = probabilities.map((_, index) => index);
            expect(boxHitProbability(probabilities, all)).toBeCloseTo(1, 10);
        }
    });

    test("独立な総当たりの実装と一致する", () => {
        const probabilities = normalized([8, 5, 3, 3, 2, 1, 1, 0.5]);
        for (const members of [
            [0, 1, 2],
            [0, 1, 2, 3],
            [1, 3, 5, 7],
            [0, 2, 3, 4, 6],
        ]) {
            expect(boxHitProbability(probabilities, members)).toBeCloseTo(
                bruteForceHitProbability(probabilities, members),
                12,
            );
        }
    });

    test("馬を足しても的中確率は下がらない", () => {
        const probabilities = normalized([8, 5, 3, 3, 2, 1, 1, 0.5]);
        let previous = 0;
        for (let size = 3; size <= probabilities.length; size++) {
            const current = boxHitProbability(
                probabilities,
                Array.from({ length: size }, (_, index) => index),
            );
            expect(current).toBeGreaterThan(previous);
            previous = current;
        }
    });

    test("馬の並びを入れ替えても的中確率は変わらない", () => {
        const probabilities = normalized([8, 5, 3, 3, 2, 1]);
        expect(boxHitProbability(probabilities, [0, 2, 4, 1])).toBeCloseTo(
            boxHitProbability(probabilities, [4, 1, 0, 2]),
            14,
        );
    });

    test("3頭未満のBoxは的中しない", () => {
        expect(boxHitProbability([0.5, 0.3, 0.2], [0, 1])).toBe(0);
        expect(boxHitProbability([0.5, 0.3, 0.2], [])).toBe(0);
    });

    test("勝率の高い馬を含むほど的中確率が高い", () => {
        const probabilities = normalized([10, 5, 3, 2, 1, 1]);
        const strong = boxHitProbability(probabilities, [0, 1, 2]);
        const weak = boxHitProbability(probabilities, [3, 4, 5]);
        expect(strong).toBeGreaterThan(weak);
    });

    test("範囲外の添字と重複は拒否する", () => {
        expect(() => boxHitProbability([0.5, 0.5], [0, 2, 3])).toThrow(RangeError);
        expect(() => boxHitProbability([0.5, 0.3, 0.2], [0, 0, 1])).toThrow(RangeError);
        expect(() => boxHitProbability([0.5, 0.3, 0.2], [-1, 0, 1])).toThrow(RangeError);
    });
});

describe("candidateBoxes", () => {
    const horseNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const probabilities = normalized([30, 20, 15, 10, 8, 6, 5, 3, 2, 1]);

    test("頭数ごとに点数の上限までの候補を 頭数の少ない順に返す", () => {
        const candidates = candidateBoxes(horseNumbers, probabilities, {
            maxTickets: DEFAULT_BOX_MAX_TICKETS,
            perSize: 2,
        });
        expect(candidates.map((candidate) => candidate.horseNumbers.length)).toEqual([3, 3, 4, 4, 5, 5]);
        expect(candidates.every((candidate) => candidate.ticketCount <= DEFAULT_BOX_MAX_TICKETS)).toBe(true);
        for (const candidate of candidates) {
            expect(candidate.ticketCount).toBe(boxTicketCount(candidate.horseNumbers.length));
            expect(candidate.costYen).toBe(candidate.ticketCount * 100);
        }
    });

    test("頭数の下限を指定すると それより少ない頭数の候補は出さない", () => {
        const candidates = candidateBoxes(horseNumbers, probabilities, { maxTickets: 60, perSize: 2, minHorses: 4 });
        expect(candidates.map((candidate) => candidate.horseNumbers.length)).toEqual([4, 4, 5, 5]);
    });

    test("頭数の下限と点数の上限が同じ頭数なら その頭数ちょうどの候補だけを返す", () => {
        const candidates = candidateBoxes(horseNumbers, probabilities, {
            maxTickets: boxTicketCount(5),
            perSize: 3,
            minHorses: 5,
        });
        expect(candidates).toHaveLength(3);
        expect(candidates.every((candidate) => candidate.horseNumbers.length === 5)).toBe(true);
        // 勝率の上位5頭が最良
        expect(candidates[0]?.horseNumbers).toEqual([1, 2, 3, 4, 5]);
    });

    test("出走頭数か点数の上限が頭数の下限に満たなければ 空を返す", () => {
        expect(
            candidateBoxes([1, 2, 3, 4], normalized([4, 3, 2, 1]), { maxTickets: 336, perSize: 2, minHorses: 5 }),
        ).toEqual([]);
        expect(candidateBoxes(horseNumbers, probabilities, { maxTickets: 24, perSize: 2, minHorses: 5 })).toEqual([]);
    });

    test.each([2, 9, 4.5, Number.NaN])("頭数の下限 %p は範囲外として拒否する", (minHorses) => {
        expect(() => candidateBoxes(horseNumbers, probabilities, { maxTickets: 60, perSize: 2, minHorses })).toThrow(
            RangeError,
        );
    });

    test("同じ頭数の中では的中確率の高い順に並ぶ", () => {
        const candidates = candidateBoxes(horseNumbers, probabilities, { maxTickets: 24, perSize: 3 });
        const fourHorse = candidates.filter((candidate) => candidate.horseNumbers.length === 4);
        expect(fourHorse).toHaveLength(3);
        for (let index = 1; index < fourHorse.length; index++) {
            expect(fourHorse[index - 1]?.hitProbability ?? 0).toBeGreaterThanOrEqual(
                fourHorse[index]?.hitProbability ?? 0,
            );
        }
    });

    test("最良の候補は全ての組み合わせを調べた結果と一致する", () => {
        const [best] = candidateBoxes(horseNumbers, probabilities, { maxTickets: 24, perSize: 1 }).filter(
            (candidate) => candidate.horseNumbers.length === 4,
        );
        let bestProbability = 0;
        for (let a = 0; a < 10; a++) {
            for (let b = a + 1; b < 10; b++) {
                for (let c = b + 1; c < 10; c++) {
                    for (let d = c + 1; d < 10; d++) {
                        bestProbability = Math.max(bestProbability, boxHitProbability(probabilities, [a, b, c, d]));
                    }
                }
            }
        }
        expect(best?.hitProbability).toBeCloseTo(bestProbability, 14);
    });

    test("馬番は昇順で 勝率の高い馬が選ばれる", () => {
        const [best] = candidateBoxes(horseNumbers, probabilities, { maxTickets: 24, perSize: 1 }).filter(
            (candidate) => candidate.horseNumbers.length === 4,
        );
        expect(best?.horseNumbers).toEqual([1, 2, 3, 4]);
    });

    test("馬番が出走順と違っても 勝率に対応した馬番を返す", () => {
        const numbers = [11, 3, 7, 1, 5];
        const weights = normalized([1, 30, 2, 20, 10]);
        const [best] = candidateBoxes(numbers, weights, { maxTickets: 6, perSize: 1 });
        // 勝率の上位3頭 = 馬番3 馬番1 馬番5
        expect(best?.horseNumbers).toEqual([1, 3, 5]);
    });

    test("勝率が同じなら馬番の小さい順に選び 結果が毎回同じになる", () => {
        const flat = normalized([1, 1, 1, 1, 1, 1]);
        const first = candidateBoxes([1, 2, 3, 4, 5, 6], flat, { maxTickets: 24, perSize: 2 });
        const second = candidateBoxes([1, 2, 3, 4, 5, 6], flat, { maxTickets: 24, perSize: 2 });
        expect(first).toEqual(second);
        expect(first.find((candidate) => candidate.horseNumbers.length === 4)?.horseNumbers).toEqual([1, 2, 3, 4]);
    });

    test("18頭立てで8頭のBoxまで調べても短時間で終わる", () => {
        const many = Array.from({ length: 18 }, (_, index) => index + 1);
        const started = performance.now();
        const candidates = candidateBoxes(many, normalized(many.map((value) => 20 - value)), {
            maxTickets: 336,
            perSize: 3,
        });
        expect(performance.now() - started).toBeLessThan(2000);
        expect(candidates.some((candidate) => candidate.horseNumbers.length === 8)).toBe(true);
    });

    test("出走頭数が少ない場合は作れる頭数までの候補だけを返す", () => {
        const candidates = candidateBoxes([1, 2, 3, 4], normalized([4, 3, 2, 1]), { maxTickets: 60, perSize: 5 });
        expect(candidates.map((candidate) => candidate.horseNumbers.length)).toEqual([3, 3, 3, 3, 4]);
    });

    test("3頭のBoxも作れない場合は空を返す", () => {
        expect(candidateBoxes(horseNumbers, probabilities, { maxTickets: 5, perSize: 3 })).toEqual([]);
        expect(candidateBoxes([1, 2], [0.6, 0.4], { maxTickets: 60, perSize: 3 })).toEqual([]);
    });

    test("長さが違う入力と 候補数が1未満は拒否する", () => {
        expect(() => candidateBoxes([1, 2, 3], [0.5, 0.5], { maxTickets: 60, perSize: 1 })).toThrow(RangeError);
        expect(() => candidateBoxes(horseNumbers, probabilities, { maxTickets: 60, perSize: 0 })).toThrow(RangeError);
    });
});

describe("alternativeBoxes", () => {
    const horseNumbers = [1, 2, 3, 4, 5, 6, 7, 8];
    const probabilities = normalized([30, 20, 15, 10, 8, 6, 5, 3]);
    const best = candidateBoxes(horseNumbers, probabilities, { maxTickets: 24, perSize: 1, minHorses: 4 })[0];

    test("最良のBoxに入らない馬ごとに その馬を入れた同じ頭数の最良のBoxを 勝率の高い順に返す", () => {
        if (best == null) {
            throw new Error("no best box");
        }
        const alternatives = alternativeBoxes(horseNumbers, probabilities, best);

        expect(best.horseNumbers).toEqual([1, 2, 3, 4]);
        expect(alternatives.map((alternative) => alternative.includes)).toEqual([5, 6, 7, 8]);
        // 5番を入れる最良は 4番を外した組み合わせ
        expect(alternatives[0]?.horseNumbers).toEqual([1, 2, 3, 5]);
        for (const alternative of alternatives) {
            expect(alternative.horseNumbers).toHaveLength(4);
            expect(alternative.horseNumbers).toContain(alternative.includes);
            expect(alternative.ticketCount).toBe(24);
            expect(alternative.costYen).toBe(2400);
        }
    });

    test("的中確率は独立な計算と一致し 低下は最良のBoxとの差で 勝率が低い馬ほど大きい", () => {
        if (best == null) {
            throw new Error("no best box");
        }
        const alternatives = alternativeBoxes(horseNumbers, probabilities, best);
        for (const alternative of alternatives) {
            const members = alternative.horseNumbers.map((horseNumber) => horseNumber - 1);
            expect(alternative.hitProbability).toBeCloseTo(bruteForceHitProbability(probabilities, members), 12);
            expect(alternative.hitProbabilityLoss).toBeCloseTo(best.hitProbability - alternative.hitProbability, 12);
            expect(alternative.hitProbabilityLoss).toBeGreaterThan(0);
        }
        const losses = alternatives.map((alternative) => alternative.hitProbabilityLoss);
        expect(losses).toEqual([...losses].sort((a, b) => a - b));
    });

    test("母集団は勝率の上位12頭で 18頭立てでも最良のBoxの外から8頭を返す", () => {
        const numbers = Array.from({ length: 18 }, (_, index) => index + 1);
        const many = normalized(numbers.map((number) => 40 - number));
        const top = candidateBoxes(numbers, many, { maxTickets: 24, perSize: 1, minHorses: 4 })[0];
        if (top == null) {
            throw new Error("no best box");
        }
        const alternatives = alternativeBoxes(numbers, many, top);
        expect(alternatives.map((alternative) => alternative.includes)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    });

    test("出走馬の全てがBoxに入る場合は 入れる馬がいないため空を返す", () => {
        const all = candidateBoxes([1, 2, 3], normalized([5, 3, 2]), { maxTickets: 6, perSize: 1 })[0];
        if (all == null) {
            throw new Error("no best box");
        }
        expect(alternativeBoxes([1, 2, 3], normalized([5, 3, 2]), all)).toEqual([]);
    });

    test("馬番と勝率の長さが違えば例外にする", () => {
        if (best == null) {
            throw new Error("no best box");
        }
        expect(() => alternativeBoxes([1, 2, 3], [0.5, 0.5], best)).toThrow(RangeError);
    });
});

describe("boxHitProbabilityByNumbers", () => {
    test("馬番から添字を引いて的中確率を求める", () => {
        const numbers = [11, 3, 7];
        const weights = normalized([5, 3, 2]);
        expect(boxHitProbabilityByNumbers(numbers, weights, [3, 7, 11])).toBeCloseTo(1, 12);
        expect(boxHitProbabilityByNumbers(numbers, weights, [11, 3])).toBe(0);
    });

    test("出走馬にない馬番は拒否する", () => {
        expect(() => boxHitProbabilityByNumbers([1, 2, 3], normalized([3, 2, 1]), [1, 2, 9])).toThrow(RangeError);
    });
});

describe("boxPayoff", () => {
    test("確定した3頭がBoxに全て含まれれば 着順に関わらず払戻を受け取る", () => {
        const results = [{ horseNumbers: [7, 2, 5], payoff: 15230 }];
        expect(boxPayoff([2, 5, 7, 9], results)).toBe(15230);
        expect(boxPayoff([2, 5, 7], results)).toBe(15230);
    });

    test("1頭でも含まれなければ外れ", () => {
        expect(boxPayoff([2, 5, 9, 10], [{ horseNumbers: [7, 2, 5], payoff: 15230 }])).toBe(0);
    });

    test("同着で確定した組み合わせが複数あれば 的中した分を足す", () => {
        const results = [
            { horseNumbers: [1, 2, 3], payoff: 5000 },
            { horseNumbers: [1, 2, 4], payoff: 5200 },
        ];
        expect(boxPayoff([1, 2, 3, 4], results)).toBe(10200);
        expect(boxPayoff([1, 2, 3], results)).toBe(5000);
    });

    test("確定した結果が無ければ0 3頭でない組み合わせは数えない", () => {
        expect(boxPayoff([1, 2, 3], [])).toBe(0);
        expect(boxPayoff([1, 2, 3], [{ horseNumbers: [1, 2], payoff: 100 }])).toBe(0);
    });
});

describe("formatHorseNumbers / parseHorseNumbers", () => {
    test("馬番は昇順の「-」区切りで保存し 同じ順に読み戻せる", () => {
        expect(formatHorseNumbers([10, 2, 7])).toBe("2-7-10");
        expect(parseHorseNumbers("2-7-10")).toEqual([2, 7, 10]);
    });

    test("元の配列は並べ替えない", () => {
        const numbers = [3, 1, 2];
        formatHorseNumbers(numbers);
        expect(numbers).toEqual([3, 1, 2]);
    });

    test.each(["", "1--2", "1-x-3", "-1-2", "1-2-", "100-2-3", "1.5-2-3"])("読めない形式 %p はnull", (text) => {
        expect(parseHorseNumbers(text)).toBeNull();
    });
});
