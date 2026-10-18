//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

// 条件付きロジット(レース内ソフトマックス)モデル レースごとに出走馬の中から勝つ馬を選ぶ確率を モデル化する
// P(馬iが勝つ) = exp(x_i・β) / Σ_j exp(x_j・β)   同じレース内の定数は打ち消されるため レース共通の項は不要

/** 学習に使う1レース分 */
export type LogitRace = {
    // 出走馬 x 特徴量
    features: number[][];
    // 馬ごとの勝ちの重み 合計は1 同着は勝った馬で等分する
    winnerWeights: number[];
};

/** 当てはめの設定 */
export type FitOptions = {
    // L2正則化の強さ 損失の和に 0.5 x l2 x Σ(倍率 x β²) を加える
    l2: number;
    // 係数ごとの正則化の倍率 省略時はすべて1 0にするとその係数は正則化しない(市場の対数確率など)
    penaltyScales?: readonly number[];
    maxIterations?: number;
    // 1回の更新量の最大値がこれを下回ったら収束とみなす
    tolerance?: number;
    // 係数の初期値 省略時は0
    initial?: readonly number[];
};

/** 当てはめの結果 */
export type FitResult = {
    coefficients: number[];
    // 正則化を含む損失
    loss: number;
    iterations: number;
    isConverged: boolean;
};

const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_TOLERANCE = 1e-7;
const MIN_STEP_SIZE = 1e-8;
const ARMIJO_FACTOR = 1e-4;

/**
 * 勝った馬を示す真偽値から 馬ごとの勝ちの重みを求める
 *
 * @param isWinners - 馬ごとに1着か
 * @returns 重み(合計1) 勝ち馬がいないレースは null
 */
export function winnerWeightsOf(isWinners: readonly boolean[]): number[] | null {
    const winnerCount = isWinners.filter(Boolean).length;
    if (winnerCount === 0) {
        return null;
    }
    return isWinners.map((isWinner) => (isWinner ? 1 / winnerCount : 0));
}

/**
 * ソフトマックス 大きな値でも桁あふれしないよう最大値を引いてから計算する
 *
 * @param scores - 馬ごとのスコア
 * @returns 合計1の確率
 */
export function softmax(scores: readonly number[]): number[] {
    const maxScore = Math.max(...scores);
    const exponentials = scores.map((score) => Math.exp(score - maxScore));
    const total = exponentials.reduce((sum, value) => sum + value, 0);
    return exponentials.map((value) => value / total);
}

/**
 * 内積
 *
 * @param left - ベクトル
 * @param right - ベクトル(leftと同じ長さ)
 * @returns 内積
 */
export function dotProduct(left: readonly number[], right: readonly number[]): number {
    let total = 0;
    for (const [index, value] of left.entries()) {
        total += value * (right[index] ?? 0);
    }
    return total;
}

type Evaluation = { loss: number; gradient: number[]; hessian: number[][] };

function evaluate(
    races: readonly LogitRace[],
    coefficients: readonly number[],
    l2: number,
    penaltyScales: readonly number[],
    needsDerivatives: boolean,
): Evaluation {
    const dimension = coefficients.length;
    const gradient: number[] = new Array<number>(dimension).fill(0);
    const hessian: number[][] = Array.from({ length: dimension }, () => new Array<number>(dimension).fill(0));
    let loss = 0;

    for (const race of races) {
        const scores = race.features.map((row) => dotProduct(row, coefficients));
        const maxScore = Math.max(...scores);
        const exponentials = scores.map((score) => Math.exp(score - maxScore));
        const total = exponentials.reduce((sum, value) => sum + value, 0);
        const logSumExp = maxScore + Math.log(total);

        let winnerScore = 0;
        for (const [index, weight] of race.winnerWeights.entries()) {
            winnerScore += weight * (scores[index] ?? 0);
        }
        loss += logSumExp - winnerScore;

        if (!needsDerivatives) {
            continue;
        }
        // 勾配 = 期待される特徴量 - 勝った馬の特徴量  ヘッセ行列 = 特徴量の分散(確率で重み付け)
        const mean: number[] = new Array<number>(dimension).fill(0);
        for (const [index, row] of race.features.entries()) {
            const probability = (exponentials[index] ?? 0) / total;
            const weight = race.winnerWeights[index] ?? 0;
            for (let a = 0; a < dimension; a++) {
                const value = row[a] ?? 0;
                mean[a] = (mean[a] ?? 0) + probability * value;
                gradient[a] = (gradient[a] ?? 0) - weight * value;
            }
        }
        for (let a = 0; a < dimension; a++) {
            gradient[a] = (gradient[a] ?? 0) + (mean[a] ?? 0);
        }
        for (const [index, row] of race.features.entries()) {
            const probability = (exponentials[index] ?? 0) / total;
            for (let a = 0; a < dimension; a++) {
                const hessianRow = hessian[a];
                if (hessianRow == null) {
                    continue;
                }
                const valueA = row[a] ?? 0;
                for (let b = a; b < dimension; b++) {
                    hessianRow[b] = (hessianRow[b] ?? 0) + probability * valueA * (row[b] ?? 0);
                }
            }
        }
        for (let a = 0; a < dimension; a++) {
            const hessianRow = hessian[a];
            if (hessianRow == null) {
                continue;
            }
            for (let b = a; b < dimension; b++) {
                hessianRow[b] = (hessianRow[b] ?? 0) - (mean[a] ?? 0) * (mean[b] ?? 0);
            }
        }
    }

    // 正則化
    for (let a = 0; a < dimension; a++) {
        const coefficient = coefficients[a] ?? 0;
        const strength = l2 * (penaltyScales[a] ?? 1);
        loss += 0.5 * strength * coefficient * coefficient;
        gradient[a] = (gradient[a] ?? 0) + strength * coefficient;
        const hessianRow = hessian[a];
        if (hessianRow != null) {
            hessianRow[a] = (hessianRow[a] ?? 0) + strength;
        }
    }
    // 上三角だけ計算したので下三角へ写す
    for (let a = 0; a < dimension; a++) {
        for (let b = 0; b < a; b++) {
            const row = hessian[a];
            if (row != null) {
                row[b] = hessian[b]?.[a] ?? 0;
            }
        }
    }
    return { loss, gradient, hessian };
}

/**
 * 対称正定値の連立方程式 matrix x = vector を コレスキー分解で解く
 *
 * @param matrix - 対称行列
 * @param vector - 右辺
 * @returns 解 正定値でない場合は null
 */
export function solveSymmetricPositiveDefinite(
    matrix: readonly (readonly number[])[],
    vector: readonly number[],
): number[] | null {
    const size = vector.length;
    const lower: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
    for (let row = 0; row < size; row++) {
        for (let column = 0; column <= row; column++) {
            let sum = matrix[row]?.[column] ?? 0;
            for (let k = 0; k < column; k++) {
                sum -= (lower[row]?.[k] ?? 0) * (lower[column]?.[k] ?? 0);
            }
            const lowerRow = lower[row];
            if (lowerRow == null) {
                return null;
            }
            if (row === column) {
                if (!(sum > 1e-12)) {
                    return null;
                }
                lowerRow[column] = Math.sqrt(sum);
            } else {
                lowerRow[column] = sum / (lower[column]?.[column] ?? 1);
            }
        }
    }
    const forward: number[] = new Array<number>(size).fill(0);
    for (let row = 0; row < size; row++) {
        let sum = vector[row] ?? 0;
        for (let k = 0; k < row; k++) {
            sum -= (lower[row]?.[k] ?? 0) * (forward[k] ?? 0);
        }
        forward[row] = sum / (lower[row]?.[row] ?? 1);
    }
    const solution: number[] = new Array<number>(size).fill(0);
    for (let row = size - 1; row >= 0; row--) {
        let sum = forward[row] ?? 0;
        for (let k = row + 1; k < size; k++) {
            sum -= (lower[k]?.[row] ?? 0) * (solution[k] ?? 0);
        }
        solution[row] = sum / (lower[row]?.[row] ?? 1);
    }
    return solution;
}

/**
 * 条件付きロジットの係数を ニュートン法(直線探索つき)で求める
 *
 * @param races - 学習に使うレース 勝ち馬のいるレースだけを渡す
 * @param dimension - 特徴量の数
 * @param options - 正則化などの設定
 * @returns 係数と損失
 * @throws {RangeError} 設定が不正な場合
 */
export function fitConditionalLogit(races: readonly LogitRace[], dimension: number, options: FitOptions): FitResult {
    if (!Number.isInteger(dimension) || dimension < 1) {
        throw new RangeError(`dimension must be a positive integer: ${dimension}`);
    }
    if (!(options.l2 >= 0) || !Number.isFinite(options.l2)) {
        throw new RangeError(`l2 must be a non-negative finite number: ${options.l2}`);
    }
    const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;

    let coefficients = options.initial != null ? [...options.initial] : new Array<number>(dimension).fill(0);
    if (coefficients.length !== dimension) {
        throw new RangeError(`initial must have ${dimension} values: ${coefficients.length}`);
    }
    const penaltyScales = options.penaltyScales ?? new Array<number>(dimension).fill(1);
    if (penaltyScales.length !== dimension || penaltyScales.some((scale) => !(scale >= 0))) {
        throw new RangeError(`penaltyScales must have ${dimension} non-negative values`);
    }
    let current = evaluate(races, coefficients, options.l2, penaltyScales, true);

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
        // 正則化があるためヘッセ行列は正定値 数値誤差で失敗した場合は対角を足して解く
        let step: number[] | null = null;
        for (let jitter = 0; step == null && jitter <= 1e3; jitter = jitter === 0 ? 1e-6 : jitter * 100) {
            const regularized = current.hessian.map((row, rowIndex) =>
                row.map((value, columnIndex) => (rowIndex === columnIndex ? value + jitter : value)),
            );
            step = solveSymmetricPositiveDefinite(regularized, current.gradient);
        }
        if (step == null) {
            return { coefficients, loss: current.loss, iterations: iteration - 1, isConverged: false };
        }

        const directionalDerivative = dotProduct(current.gradient, step);
        let stepSize = 1;
        let next: Evaluation | null = null;
        let nextCoefficients = coefficients;
        while (stepSize >= MIN_STEP_SIZE) {
            nextCoefficients = coefficients.map((value, index) => value - stepSize * (step[index] ?? 0));
            const candidate = evaluate(races, nextCoefficients, options.l2, penaltyScales, false);
            if (candidate.loss <= current.loss - ARMIJO_FACTOR * stepSize * directionalDerivative) {
                next = candidate;
                break;
            }
            stepSize /= 2;
        }
        if (next == null) {
            // これ以上改善できない
            return { coefficients, loss: current.loss, iterations: iteration, isConverged: true };
        }

        const largestChange = Math.max(...step.map((value) => Math.abs(stepSize * value)));
        coefficients = nextCoefficients;
        current = evaluate(races, coefficients, options.l2, penaltyScales, true);
        if (largestChange < tolerance) {
            return { coefficients, loss: current.loss, iterations: iteration, isConverged: true };
        }
    }
    return { coefficients, loss: current.loss, iterations: maxIterations, isConverged: false };
}
