//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import type { PredictionWithResult } from "../db/prediction-repository.ts";
import type { PeriodMetrics, PickStats } from "./evaluation.ts";
import type { PredictTodayResult, RacePrediction } from "./live.ts";
import type { TrainingResult } from "./train.ts";
import type { ValueCriteria } from "./value.ts";

// 端末で全角は半角2つ分の幅 半角カナ(U+FF61〜U+FF9F)は1つ分
function displayWidth(text: string): number {
    let width = 0;
    for (const character of text) {
        const code = character.codePointAt(0) ?? 0;
        width += code <= 0x7f || (code >= 0xff61 && code <= 0xff9f) ? 1 : 2;
    }
    return width;
}

function padEndDisplay(text: string, width: number): string {
    return text + " ".repeat(Math.max(width - displayWidth(text), 0));
}

function padStartDisplay(text: string, width: number): string {
    return " ".repeat(Math.max(width - displayWidth(text), 0)) + text;
}

const percent = (value: number, digits = 1): string => `${(value * 100).toFixed(digits)}%`;

/**
 * 抽出条件を1行の文章にする
 *
 * @param criteria - 抽出条件
 * @returns 条件の説明
 */
export function describeCriteria(criteria: ValueCriteria): string {
    const parts = [
        `オッズ ${criteria.minOdds}倍以上`,
        `人気 ${criteria.minPopularity}位以下`,
        `モデル勝率 ${criteria.maxModelRank}位以内`,
    ];
    if (criteria.minExpectedValue > 0) {
        parts.push(`期待値(勝率 x オッズ) ${criteria.minExpectedValue}以上`);
    }
    return parts.join(" かつ ");
}

function describePicks(label: string, stats: PickStats): string {
    if (stats.bets === 0) {
        return `  ${label}: 該当なし`;
    }
    const margin = 2 * stats.returnRateStandardError;
    const isDistinguishable = Math.abs(stats.returnRate - 1) > margin;
    return [
        `  ${label}: ${stats.bets}頭 的中${stats.hits} 的中率${percent(stats.hitRate)}`,
        `(モデルの見積もり${percent(stats.meanPredictedProbability)}) 平均オッズ${stats.meanOdds.toFixed(1)}`,
        `回収率${percent(stats.returnRate, 0)}±${percent(stats.returnRateStandardError, 0)}`,
        isDistinguishable ? "" : "(100%との差は誤差の範囲)",
    ]
        .filter((part) => part !== "")
        .join(" ");
}

function describePeriod(title: string, metrics: PeriodMetrics): string[] {
    const improvement = metrics.meanLogLoss.market - metrics.meanLogLoss.model;
    return [
        `${title} ${metrics.from} 〜 ${metrics.to} (${metrics.races}レース)`,
        `  対数損失(小さいほど良い): 市場 ${metrics.meanLogLoss.market.toFixed(4)} / モデル ${metrics.meanLogLoss.model.toFixed(4)} (改善 ${improvement.toFixed(4)})`,
        `  本命の的中率: 市場 ${percent(metrics.top1HitRate.market)} / モデル ${percent(metrics.top1HitRate.model)}`,
        describePicks("抽出した馬", metrics.valuePicks),
        describePicks("比較: オッズと人気の条件だけが同じ全馬", metrics.longshotBaseline),
    ];
}

/**
 * 学習結果の報告を作る
 *
 * @param result - 学習結果
 * @param modelId - 保存したモデルのID 保存しなかった場合はnull
 * @returns 表示する文章
 */
export function formatTrainingReport(result: TrainingResult, modelId: number | null): string {
    const { split } = result;
    const lines = [
        `学習が完了しました${modelId == null ? "" : ` (モデル #${modelId})`}`,
        "",
        `履歴の開始 ${split.historyFrom} / 学習 ${split.trainFrom} 〜 / 検証 ${split.validFrom} 〜 / テスト ${split.testFrom} 〜 ${split.dataTo}`,
        `レース数: 学習 ${result.races.train} / 検証 ${result.races.valid} / テスト ${result.races.test}`,
        `L2正則化: ${result.l2Candidates.map((c) => `${c.l2}→${c.validLogLoss.toFixed(4)}`).join(" ")} → ${result.selectedL2} を採用`,
        `市場の対数確率の係数: ${result.parameters.marketCoefficient.toFixed(3)} (1なら市場をそのまま信じる)`,
        `抽出条件: ${describeCriteria(result.criteria)}`,
        "",
        ...describePeriod("検証期間", result.valid),
        "",
        ...describePeriod("テスト期間", result.test),
        "",
        "【注意】",
        "  対数損失の改善が小さい(誤差程度)場合、モデルは市場の勝率と大差なく、割安な馬を見つけられていません。",
        "  回収率は賭けた頭数が少ないと大きくぶれます。誤差の範囲を超えるまでは、儲かる根拠にはなりません。",
        "  抽出条件は検証期間とテスト期間の両方を見て調べたため、テスト期間の成績は完全には独立していません。",
        "  今日以降の予測はPostgreSQLに残るので、--report で確定後の結果と突き合わせて検証してください。",
    ];
    return `${lines.join("\n")}\n`;
}

const RUNNER_COLUMNS: ReadonlyArray<{ title: string; width: number }> = [
    { title: "人気", width: 4 },
    { title: "馬番", width: 4 },
    { title: "馬名", width: 20 },
    { title: "オッズ", width: 7 },
    { title: "市場勝率", width: 8 },
    { title: "モデル勝率", width: 10 },
    { title: "順位", width: 4 },
    { title: "比率", width: 6 },
    { title: "期待値", width: 6 },
];

// 馬名の列だけ左揃え
const NAME_COLUMN_INDEX = 2;

function formatRace(prediction: RacePrediction): string[] {
    const time = prediction.capturedAt.toTimeString().slice(0, 8);
    const lines = [
        `■ ${prediction.raceName}${prediction.postTime == null ? "" : ` ${prediction.postTime}発走`} (${prediction.raceId}) オッズ取得 ${time}`,
        `  ${RUNNER_COLUMNS.map((column, index) => (index === NAME_COLUMN_INDEX ? padEndDisplay : padStartDisplay)(column.title, column.width)).join(" ")}`,
    ];
    for (const runner of prediction.runners) {
        const cells = [
            String(runner.popularity),
            String(runner.horseNumber),
            runner.horseName ?? "",
            runner.odds.toFixed(1),
            percent(runner.marketProbability),
            percent(runner.modelProbability),
            String(runner.modelRank),
            runner.edgeRatio.toFixed(2),
            runner.expectedValue.toFixed(2),
        ];
        const row = cells
            .map((cell, index) => {
                const width = RUNNER_COLUMNS[index]?.width ?? 0;
                return index === NAME_COLUMN_INDEX ? padEndDisplay(cell, width) : padStartDisplay(cell, width);
            })
            .join(" ");
        lines.push(`${runner.isValuePick ? "★" : " "} ${row}`);
    }
    return lines;
}

/**
 * 当日の予測の報告を作る
 *
 * @param result - 当日予測の結果
 * @param criteria - 抽出条件
 * @param isVerbose - 全レースの全出走馬を表示するか falseなら抽出した馬を含むレースだけ
 * @returns 表示する文章
 */
export function formatPredictions(result: PredictTodayResult, criteria: ValueCriteria, isVerbose: boolean): string {
    const picks = result.predictions.flatMap((prediction) =>
        prediction.runners.filter((runner) => runner.isValuePick).map((runner) => ({ prediction, runner })),
    );
    const lines = [
        `${result.date} 当日開催の中央競馬 ${result.predictions.length}レースを予測しました (モデル #${result.modelId})`,
        `抽出条件: ${describeCriteria(criteria)}`,
        "",
    ];

    if (picks.length === 0) {
        lines.push("条件を満たす馬はいません。", "");
    } else {
        lines.push(`★ 条件を満たす馬 ${picks.length}頭`);
        for (const { prediction, runner } of picks) {
            lines.push(
                `  ${prediction.raceName}${prediction.postTime == null ? "" : ` (${prediction.postTime}発走)`}` +
                    ` 馬番${runner.horseNumber} ${runner.horseName ?? ""}` +
                    ` ${runner.popularity}番人気 ${runner.odds.toFixed(1)}倍` +
                    ` 勝率 市場${percent(runner.marketProbability)} → モデル${percent(runner.modelProbability)}` +
                    ` (${runner.modelRank}位) 期待値${runner.expectedValue.toFixed(2)}`,
            );
        }
        lines.push("");
    }

    for (const prediction of result.predictions) {
        if (isVerbose || prediction.runners.some((runner) => runner.isValuePick)) {
            lines.push(...formatRace(prediction), "");
        }
    }
    if (!isVerbose) {
        lines.push("(全レース・全出走馬は --verbose で表示します)", "");
    }
    if (result.skippedRaceIds.length > 0) {
        lines.push(`予測できなかったレース: ${result.skippedRaceIds.join(" ")} (発売前でオッズが無い場合など)`, "");
    }
    lines.push(
        "【注意】オッズは発売中の暫定値で、発走直前までに動きます。モデルは学習時の確定オッズで補正を学んでいます。",
        "  過去成績の特徴量は市場がすでに織り込んでおり、市場を上回る根拠は検証で確認できていません(--train の報告を参照)。",
    );
    return `${lines.join("\n")}\n`;
}

/**
 * 保存済みの予測と確定した結果の突き合わせを作る
 *
 * @param date - 開催日
 * @param rows - 予測と結果
 * @returns 表示する文章
 */
export function formatVerification(date: string, rows: readonly PredictionWithResult[]): string {
    if (rows.length === 0) {
        return `${date} の保存済みの予測はありません (-P で予測してください)\n`;
    }
    const raceCount = new Set(rows.map((row) => row.raceId)).size;
    const picks = rows.filter((row) => row.isValuePick);
    const settled = picks.filter((row) => row.hasResult);
    const lines = [
        `${date} の予測 ${raceCount}レース (レースごとに最後に取得した分) と結果の突き合わせ`,
        `結果が取り込み済みのレース: ${new Set(rows.filter((row) => row.hasResult).map((row) => row.raceId)).size}/${raceCount} (未取り込みは -U -S で取り込む)`,
        "",
    ];
    if (picks.length === 0) {
        lines.push("抽出した馬はいません。");
        return `${lines.join("\n")}\n`;
    }
    lines.push(`★ 抽出した馬 ${picks.length}頭`);
    for (const row of picks) {
        const result = !row.hasResult
            ? "結果未取り込み"
            : row.orderOfFinish == null
              ? "着順なし(取消・中止など)"
              : `${row.orderOfFinish}着${row.winPayoff == null ? "" : ` 払戻${row.winPayoff}円`}`;
        lines.push(
            `  ${row.raceName} 馬番${row.horseNumber} ${row.horseName ?? ""} ${row.popularity ?? "-"}番人気` +
                ` ${row.odds.toFixed(1)}倍 モデル${percent(row.modelProbability)}(市場${percent(row.marketProbability)})` +
                ` 期待値${row.expectedValue.toFixed(2)} → ${result}`,
        );
    }
    if (settled.length > 0) {
        const hits = settled.filter((row) => row.orderOfFinish === 1);
        const payout = hits.reduce((sum, row) => sum + (row.winPayoff ?? row.odds * 100), 0);
        lines.push(
            "",
            `結果が出た${settled.length}頭: 的中${hits.length} 回収率${percent(payout / (settled.length * 100), 0)} (単勝100円ずつ)`,
        );
    }
    return `${lines.join("\n")}\n`;
}
