//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { dotProduct, fitConditionalLogit, type LogitRace, softmax, winnerWeightsOf } from "./conditional-logit.ts";
import { FEATURE_NAMES } from "./history.ts";
import { marketProbabilities } from "./market.ts";
import type { RaceSample } from "./types.ts";

// 勝率は「市場の勝率(オッズ)を土台に 過去成績で補正する」条件付きロジットで見積もる
//   スコア = marketCoefficient x ln(市場の勝率) + Σ 係数 x 標準化した特徴量
// 過去成績だけで勝率を作ると 市場が持つ情報(調教・状態・直前の気配など)を知らないため
// 市場より勝率が高く見える馬の多くは ただの見落としではなく 情報不足の産物になる
// 市場を土台にすると 市場と差がつくのは「過去成績が市場の織り込み以上に示す分」だけになる

/** 保存・復元する学習済みモデル */
export type ModelParameters = {
    version: 1;
    featureNames: string[];
    // 特徴量の標準化と係数
    means: number[];
    stds: number[];
    coefficients: number[];
    // 市場の対数確率にかける係数 1なら市場をそのまま信じる
    marketCoefficient: number;
    // 特徴量の係数に課したL2正則化の強さ
    l2: number;
};

const MIN_STANDARD_DEVIATION = 1e-9;

/**
 * サンプルの全出走馬から 特徴量ごとの平均と標準偏差を求める
 *
 * @param samples - 学習用のサンプル
 * @returns 平均と標準偏差 標準偏差が0の特徴量は1にして割り算を安全にする
 */
export function standardizationOf(samples: readonly RaceSample[]): { means: number[]; stds: number[] } {
    const dimension = FEATURE_NAMES.length;
    const sums: number[] = new Array<number>(dimension).fill(0);
    const squareSums: number[] = new Array<number>(dimension).fill(0);
    let count = 0;
    for (const sample of samples) {
        for (const row of sample.features) {
            count += 1;
            for (let index = 0; index < dimension; index++) {
                const value = row[index] ?? 0;
                sums[index] = (sums[index] ?? 0) + value;
                squareSums[index] = (squareSums[index] ?? 0) + value * value;
            }
        }
    }
    const means = sums.map((sum) => (count === 0 ? 0 : sum / count));
    const stds = squareSums.map((squareSum, index) => {
        const mean = means[index] ?? 0;
        const deviation = Math.sqrt(Math.max(count === 0 ? 0 : squareSum / count - mean * mean, 0));
        return deviation < MIN_STANDARD_DEVIATION ? 1 : deviation;
    });
    return { means, stds };
}

type Standardization = Pick<ModelParameters, "means" | "stds">;

// 先頭が市場の対数確率 続きが標準化した特徴量の 学習用の行を作る
function designRows(
    standardization: Standardization,
    features: readonly (readonly number[])[],
    marketProbabilityList: readonly number[],
): number[][] {
    return features.map((row, index) => [
        Math.log(marketProbabilityList[index] ?? 1),
        ...row.map(
            (value, column) => (value - (standardization.means[column] ?? 0)) / (standardization.stds[column] ?? 1),
        ),
    ]);
}

/** 1レースの勝率 */
export type RaceProbabilities = {
    // 控除率を除いた市場の勝率
    market: number[];
    // 市場を土台に過去成績で補正した勝率 予測に使う
    model: number[];
};

/**
 * 1レースの勝率を求める
 *
 * @param parameters - 学習済みモデル
 * @param features - 出走馬 x 特徴量(標準化前)
 * @param odds - 出走馬ごとの単勝オッズ
 * @returns 市場とモデルの勝率
 */
export function probabilitiesOfRace(
    parameters: ModelParameters,
    features: readonly (readonly number[])[],
    odds: readonly number[],
): RaceProbabilities {
    const market = marketProbabilities(odds);
    const coefficients = [parameters.marketCoefficient, ...parameters.coefficients];
    const scores = designRows(parameters, features, market).map((row) => dotProduct(row, coefficients));
    return { market, model: softmax(scores) };
}

/** 学習の設定 */
export type FitModelOptions = {
    // 特徴量の係数のL2正則化の強さ
    l2: number;
};

/**
 * モデルを学習する
 *
 * 市場の係数は正則化しない(1付近から動かすのは 市場の校正に偏りがある場合だけにするため 初期値は1)
 *
 * @param trainSamples - 学習期間のサンプル
 * @param options - 学習の設定
 * @returns 学習済みモデル
 */
export function fitModel(trainSamples: readonly RaceSample[], options: FitModelOptions): ModelParameters {
    const standardization = standardizationOf(trainSamples);
    const races: LogitRace[] = [];
    for (const sample of trainSamples) {
        const winnerWeights = winnerWeightsOf(sample.isWinners);
        if (winnerWeights != null) {
            races.push({
                features: designRows(standardization, sample.features, marketProbabilities(sample.odds)),
                winnerWeights,
            });
        }
    }
    const dimension = 1 + FEATURE_NAMES.length;
    const fit = fitConditionalLogit(races, dimension, {
        l2: options.l2,
        initial: [1, ...FEATURE_NAMES.map(() => 0)],
        penaltyScales: [0, ...FEATURE_NAMES.map(() => 1)],
    });
    return {
        version: 1,
        featureNames: [...FEATURE_NAMES],
        ...standardization,
        coefficients: fit.coefficients.slice(1),
        marketCoefficient: fit.coefficients[0] ?? 1,
        l2: options.l2,
    };
}

/**
 * 保存されたJSONを学習済みモデルとして検証する
 *
 * @param value - DBから読んだJSON
 * @returns 学習済みモデル
 * @throws {TypeError} 形式が違う または特徴量の構成が現在のコードと違う場合
 */
export function parseModelParameters(value: unknown): ModelParameters {
    if (typeof value !== "object" || value === null) {
        throw new TypeError("model parameters must be an object");
    }
    const record = value as Record<string, unknown>; // 直後に各項目を検証する
    const isNumberArray = (item: unknown): item is number[] =>
        Array.isArray(item) && item.every((element) => typeof element === "number" && Number.isFinite(element));
    const { featureNames, means, stds, coefficients, marketCoefficient, l2 } = record;

    if (record.version !== 1) {
        throw new TypeError(`unsupported model version: ${String(record.version)}`);
    }
    if (
        !Array.isArray(featureNames) ||
        featureNames.length !== FEATURE_NAMES.length ||
        featureNames.some((name, index) => name !== FEATURE_NAMES[index])
    ) {
        throw new TypeError("model features do not match the current code: train the model again");
    }
    if (
        !isNumberArray(means) ||
        !isNumberArray(stds) ||
        !isNumberArray(coefficients) ||
        means.length !== FEATURE_NAMES.length ||
        stds.length !== FEATURE_NAMES.length ||
        coefficients.length !== FEATURE_NAMES.length ||
        typeof marketCoefficient !== "number" ||
        !Number.isFinite(marketCoefficient) ||
        typeof l2 !== "number"
    ) {
        throw new TypeError("model parameters are malformed");
    }
    return {
        version: 1,
        featureNames: featureNames.map(String),
        means,
        stds,
        coefficients,
        marketCoefficient,
        l2,
    };
}
