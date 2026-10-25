//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import type { BoxProposalWithResult, ExcludedRace, PredictionWithResult } from "../db/prediction-repository.ts";
import type { BoxProposal } from "./ai-box.ts";
import type { ImprovementStats, PeriodMetrics, PickStats } from "./evaluation.ts";
import type { PredictTodayResult, RacePrediction } from "./live.ts";
import type { TrainingResult } from "./train.ts";
import { boxPayoff, boxTicketCount, formatHorseNumbers, TICKET_PRICE_YEN } from "./trifecta.ts";
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

// 対数損失の改善が 標準誤差の2倍を超えているかを言葉にする(超えていなければ 誤差と区別できない)
function describeImprovement(improvement: ImprovementStats): string {
    const sign = improvement.mean >= 0 ? "" : "-";
    const value = `${sign}${Math.abs(improvement.mean).toFixed(4)} ±${improvement.standardError.toFixed(4)}`;
    if (improvement.standardError === 0) {
        return value;
    }
    if (improvement.mean >= 2 * improvement.standardError) {
        return `${value} 誤差を超えています`;
    }
    if (improvement.mean <= -2 * improvement.standardError) {
        return `${value} 市場より悪化しています`;
    }
    return `${value} 誤差の範囲です`;
}

function describePeriod(title: string, metrics: PeriodMetrics, note = ""): string[] {
    return [
        `${title} ${metrics.from} 〜 ${metrics.to} (${metrics.races}レース${note})`,
        `  対数損失(小さいほど良い): 市場 ${metrics.meanLogLoss.market.toFixed(4)} / モデル ${metrics.meanLogLoss.model.toFixed(4)}`,
        `  対数損失の改善(市場 - モデル): ${describeImprovement(metrics.improvement)}`,
        `  本命の的中率: 市場 ${percent(metrics.top1HitRate.market)} / モデル ${percent(metrics.top1HitRate.model)}`,
        describePicks("抽出した馬", metrics.valuePicks),
        describePicks("比較: オッズと人気の条件だけが同じ全馬", metrics.longshotBaseline),
    ];
}

// 開発期間の区間ごとの改善 区間によってぶれる様子が分かる
function describeBlocks(blocks: readonly PeriodMetrics[]): string[] {
    const races = Math.max(...blocks.map((block) => String(block.races).length));
    return [
        "  区間ごとの対数損失の改善(市場 - モデル):",
        ...blocks.map(
            (block) =>
                `    ${block.from} 〜 ${block.to} ${padStartDisplay(String(block.races), races)}レース ${describeImprovement(block.improvement)}`,
        ),
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
        `履歴の開始 ${split.historyFrom} / 学習 ${split.trainFrom} 〜 / 開発 ${split.validFrom} 〜 / テスト ${split.testFrom} 〜 ${split.dataTo}`,
        `レース数: 開発の最初の学習 ${result.races.train} / 開発 ${result.races.dev} / テスト ${result.races.test}`,
        `L2正則化(開発期間の対数損失): ${result.l2Candidates.map((c) => `${c.l2}→${c.devLogLoss.toFixed(4)}`).join(" ")} → ${result.selectedL2} を採用`,
        `保存したモデルは、テスト期間も含む全期間(${result.races.all}レース)で学習し直したものです 下の成績は 再学習する前の同じ手順のモデルで測っています`,
        `市場の対数確率の係数: ${result.parameters.marketCoefficient.toFixed(3)} (1なら市場をそのまま信じる)`,
        `抽出条件: ${describeCriteria(result.criteria)}`,
        "",
        ...describePeriod(
            "開発期間",
            result.dev,
            `、${result.devBlocks.length}区間 各区間は直前までの全期間で学習 L2の選択に使った区間のため やや楽観的`,
        ),
        ...describeBlocks(result.devBlocks),
        "",
        ...describePeriod("テスト期間", result.test),
        "",
        "【注意】",
        "  対数損失の改善が誤差(標準誤差の2倍)に届かない場合、モデルは市場の勝率と区別できず、割安な馬を見つけられていません。",
        "  回収率は賭けた頭数が少ないと大きくぶれます。誤差の範囲を超えるまでは、儲かる根拠にはなりません。",
        "  開発期間の成績は、L2の選択に使った区間の成績で、やや良く出ます。一度も使っていないテスト期間の成績を重く見てください。",
        "  抽出条件は開発期間とテスト期間の両方を見て調べたため、成績は完全には独立していません。",
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

// 検証から外したレースの一覧 多い場合は先頭の数件だけ名前を出す
const MAX_LISTED_EXCLUDED_RACES = 5;

function describeExcludedRaces(excluded: readonly ExcludedRace[]): string {
    const names = excluded.slice(0, MAX_LISTED_EXCLUDED_RACES).map((race) => race.raceName);
    const rest = excluded.length - names.length;
    return `${names.join("、")}${rest > 0 ? ` ほか${rest}レース` : ""}`;
}

/**
 * 保存済みの予測と確定した結果の突き合わせを作る
 *
 * @param date - 開催日
 * @param rows - 予測と結果
 * @param excluded - 発走後にしか予測を取得しておらず 検証から外したレース
 * @returns 表示する文章
 */
export function formatVerification(
    date: string,
    rows: readonly PredictionWithResult[],
    excluded: readonly ExcludedRace[] = [],
): string {
    if (rows.length === 0) {
        return excluded.length === 0
            ? `${date} の保存済みの予測はありません (-P で予測してください)\n`
            : `${date} の発走前に取得した予測はありません (発走後にだけ取得した ${excluded.length}レースは検証から除外: ${describeExcludedRaces(excluded)})\n`;
    }
    const raceCount = new Set(rows.map((row) => row.raceId)).size;
    const picks = rows.filter((row) => row.isValuePick);
    const settled = picks.filter((row) => row.hasResult);
    const lines = [
        `${date} の予測 ${raceCount}レース (レースごとに発走前に最後に取得した分 発走時刻が不明なレースは最後に取得した分) と結果の突き合わせ`,
        `結果が取り込み済みのレース: ${new Set(rows.filter((row) => row.hasResult).map((row) => row.raceId)).size}/${raceCount} (未取り込みは -U -S で取り込む)`,
    ];
    if (excluded.length > 0) {
        lines.push(
            `発走後にだけ取得したため検証から除外したレース: ${excluded.length} (${describeExcludedRaces(excluded)})`,
        );
    }
    lines.push("");
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

const yen = (value: number): string => `${Math.round(value).toLocaleString("en-US")}円`;

// 頭数と点数と購入額 例: 4頭 24点 2,400円
function describeBox(horseNumbers: readonly number[]): string {
    const tickets = boxTicketCount(horseNumbers.length);
    return `${horseNumbers.length}頭 ${tickets}点 ${yen(tickets * TICKET_PRICE_YEN)}`;
}

/** 3連単Boxの提案の報告に必要な内容 */
export type BoxProposalReport = {
    // 開催日(YYYY-MM-DD)
    date: string;
    proposals: readonly BoxProposal[];
    // 予測や提案ができなかったレースID
    skippedRaceIds: readonly number[];
    // 点数の上限
    maxTickets: number;
    // 頭数を指定した場合(その頭数ちょうどのBox)の頭数 指定しないならnull
    fixedHorses?: number | null;
};

/**
 * 3連単Boxの提案の報告を作る
 *
 * @param report - 提案と設定
 * @returns 表示する文章
 */
export function formatBoxProposals(report: BoxProposalReport): string {
    const { date, proposals, skippedRaceIds, maxTickets, fixedHorses = null } = report;
    const condition =
        fixedHorses == null
            ? `点数の上限${maxTickets}点(${yen(maxTickets * TICKET_PRICE_YEN)})`
            : `${fixedHorses}頭 ${maxTickets}点(${yen(maxTickets * TICKET_PRICE_YEN)})`;
    const lines = [
        `3連単Boxの提案 ${date} ${condition}`,
        "  的中確率は、モデルの勝率から Harville 式で求めた目安です(強い馬ほど上位に偏る仮定で、実際とはずれます)。",
        "",
    ];
    for (const proposal of proposals) {
        const postTime = proposal.postTime == null ? "" : ` ${proposal.postTime}発走`;
        lines.push(`■ ${proposal.raceName}${postTime} (race ${proposal.raceId})`);
        lines.push(`  Box: ${formatHorseNumbers(proposal.horseNumbers)}  ${describeBox(proposal.horseNumbers)}`);
        for (const horse of proposal.horses) {
            lines.push(
                `    ${String(horse.horseNumber).padStart(2)}番 ${padEndDisplay(horse.horseName ?? "", 18)}` +
                    ` ${horse.popularity}番人気 ${horse.odds.toFixed(1)}倍 モデル勝率${percent(horse.modelProbability)}`,
            );
        }
        const baseline = proposal.baseline.horseNumbers;
        lines.push(
            `  的中確率: ${percent(proposal.hitProbability)}` +
                ` (同じ頭数の最良 ${percent(proposal.bestHitProbability)}、` +
                `点数の上限内の最良 ${formatHorseNumbers(baseline)} の${percent(proposal.baseline.hitProbability)})`,
        );
        lines.push(
            proposal.source === "ai"
                ? `  選定: AI (${proposal.aiModel ?? "不明"})`
                : "  選定: AIを使えず、点数の上限内で的中確率が最も高いBoxにしました",
        );
        lines.push(`  理由: ${proposal.reason}`);
        if (proposal.caution != null) {
            lines.push(`  注意: ${proposal.caution}`);
        }
        lines.push("");
    }
    if (proposals.length === 0) {
        lines.push("提案できたレースはありません。", "");
    }
    if (skippedRaceIds.length > 0) {
        lines.push(`提案できなかったレース: ${skippedRaceIds.join(" ")} (発売前でオッズが無い場合など)`, "");
    }
    lines.push(
        "【注意】3連単のオッズは使っていないため、期待値(回収率)は見積もっていません。3連単は控除率が高く(払戻率は7割台)、",
        "  的中も回収も保証しません。勝率のモデルは市場に対する上積みを確認できていません(--train の報告を参照)。",
        "  提案は保存してあり、レースが確定して結果を取り込んだら --report で実際の3連単と突き合わせられます。",
    );
    return `${lines.join("\n")}\n`;
}

type BoxSettlement = { cost: number; payoff: number; isHit: boolean };

// Boxを1点100円ずつ買った場合の購入額と払戻
function settleBox(horseNumbers: readonly number[], row: BoxProposalWithResult): BoxSettlement {
    const payoff = boxPayoff(horseNumbers, row.winningTickets);
    return { cost: boxTicketCount(horseNumbers.length) * TICKET_PRICE_YEN, payoff, isHit: payoff > 0 };
}

function describeSettlement(settlement: BoxSettlement): string {
    return settlement.isHit ? `的中 払戻${yen(settlement.payoff)}` : "外れ";
}

function describeTotals(label: string, settlements: readonly BoxSettlement[]): string {
    const cost = settlements.reduce((sum, item) => sum + item.cost, 0);
    const payoff = settlements.reduce((sum, item) => sum + item.payoff, 0);
    const hits = settlements.filter((item) => item.isHit).length;
    return `  ${label}: 的中${hits}/${settlements.length} 購入${yen(cost)} 払戻${yen(payoff)} 回収率${percent(payoff / cost, 0)}`;
}

/**
 * 保存済みのBoxの提案と 確定した3連単の突き合わせを作る
 *
 * 提案と 基準(点数の上限内で的中確率が最も高いBox)を 同じレースで比べる
 * AIを使えず切り替えた提案は基準と同じBoxなので 差はAIの選定によるものになる
 *
 * @param date - 開催日
 * @param rows - 提案と結果
 * @param excluded - 発走後にしか提案しておらず 検証から外したレース
 * @returns 表示する文章 提案が無い場合は空の文字列
 */
export function formatBoxVerification(
    date: string,
    rows: readonly BoxProposalWithResult[],
    excluded: readonly ExcludedRace[] = [],
): string {
    if (rows.length === 0) {
        return excluded.length === 0
            ? ""
            : `${date} の発走前の3連単Boxの提案はありません (発走後にだけ提案した ${excluded.length}レースは検証から除外: ${describeExcludedRaces(excluded)})\n`;
    }
    const settledRows = rows.filter((row) => row.hasResult && row.winningTickets.length > 0);
    const lines = [
        `${date} の3連単Boxの提案 ${rows.length}レース (レースごとに発走前の最後の提案 発走時刻が不明なレースは最後の提案) と結果の突き合わせ`,
        `結果が取り込み済みのレース: ${settledRows.length}/${rows.length} (未取り込みは -U -S で取り込む)`,
    ];
    if (excluded.length > 0) {
        lines.push(
            `発走後にだけ提案したため検証から除外したレース: ${excluded.length} (${describeExcludedRaces(excluded)})`,
        );
    }
    lines.push("");
    for (const row of rows) {
        const proposed = settleBox(row.horseNumbers, row);
        const baseline = settleBox(row.baselineHorseNumbers, row);
        const source = row.source === "ai" ? "AI" : "AI不使用";
        lines.push(`■ ${row.raceName} (race ${row.raceId})`);
        if (!row.hasResult) {
            lines.push(
                `  提案(${source}) ${formatHorseNumbers(row.horseNumbers)} ${describeBox(row.horseNumbers)}` +
                    ` 的中確率${percent(row.hitProbability)} → 結果未取り込み`,
            );
        } else if (row.winningTickets.length === 0) {
            lines.push(
                `  提案(${source}) ${formatHorseNumbers(row.horseNumbers)} ${describeBox(row.horseNumbers)}` +
                    " → 3連単の払戻の記録なし(中止など)",
            );
        } else {
            lines.push(
                `  提案(${source}) ${formatHorseNumbers(row.horseNumbers)} ${describeBox(row.horseNumbers)}` +
                    ` 的中確率${percent(row.hitProbability)} → ${describeSettlement(proposed)}`,
                `  基準 ${formatHorseNumbers(row.baselineHorseNumbers)} ${describeBox(row.baselineHorseNumbers)}` +
                    ` 的中確率${percent(row.baselineHitProbability)} → ${describeSettlement(baseline)}`,
            );
        }
    }
    if (settledRows.length > 0) {
        lines.push(
            "",
            `結果が出た${settledRows.length}レース (1点${TICKET_PRICE_YEN}円ずつ)`,
            describeTotals(
                "提案",
                settledRows.map((row) => settleBox(row.horseNumbers, row)),
            ),
            describeTotals(
                "基準",
                settledRows.map((row) => settleBox(row.baselineHorseNumbers, row)),
            ),
            "  基準は点数の上限内で的中確率が最も高いBoxです。レース数が少ないうちは、回収率の差は偶然に左右されます。",
        );
    }
    return `${lines.join("\n")}\n`;
}
