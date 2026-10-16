//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

const REFRESH_INTERVAL_MS = 250;
const BAR_WIDTH = 30;

function formatDuration(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** 処理済み件数の進捗を標準エラー出力へ表示する */
export type ProgressReporter = {
    // 処理が1件進むたびに呼ぶ
    advance(): void;
    // 表示を締めくくる
    finish(): void;
};

/**
 * 進捗表示を作る
 *
 * 端末では同じ行を書き換えるバーを表示し 端末でない場合(ログ出力など)は10%ごとに1行出力する
 *
 * @param total - 全体の件数
 * @param label - 表示の先頭に付ける名前
 * @returns 進捗表示
 */
export function createProgressReporter(total: number, label: string): ProgressReporter {
    const startedAt = Date.now();
    const isTerminal = process.stderr.isTTY === true;
    let done = 0;
    let lastRenderedAt = 0;
    let lastDecile = -1;

    const render = (isFinal: boolean): void => {
        const ratio = total === 0 ? 1 : done / total;
        const elapsedSeconds = (Date.now() - startedAt) / 1000;
        const remainingSeconds = done === 0 ? 0 : (elapsedSeconds / done) * (total - done);
        const percent = String(Math.floor(ratio * 100)).padStart(3, " ");

        if (isTerminal) {
            const filled = Math.floor(ratio * BAR_WIDTH);
            const bar = "█".repeat(filled) + " ".repeat(BAR_WIDTH - filled);
            const elapsed = formatDuration(elapsedSeconds);
            const remaining = formatDuration(remainingSeconds);
            process.stderr.write(
                `\r${label} ${percent}%|${bar}| ${done}/${total} [${elapsed}<${remaining}]${isFinal ? "\n" : ""}`,
            );
            return;
        }

        const decile = Math.floor(ratio * 10);
        if (isFinal || decile > lastDecile) {
            lastDecile = decile;
            process.stderr.write(`${label} ${percent}% ${done}/${total}\n`);
        }
    };

    return {
        advance(): void {
            done++;
            const now = Date.now();
            if (done === total || now - lastRenderedAt >= REFRESH_INTERVAL_MS) {
                lastRenderedAt = now;
                // 最後の1件は finish() で表示するため ここでは途中経過だけ描く
                if (done !== total) {
                    render(false);
                }
            }
        },
        finish(): void {
            render(true);
        },
    };
}
