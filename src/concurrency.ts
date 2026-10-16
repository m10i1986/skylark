//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

/**
 * 同時実行数を制限して全要素を処理する
 *
 * 要素の数だけPromiseを作らず 固定数のワーカーが順に取り出して処理する
 * いずれかの処理が失敗した場合は 新しい要素の取り出しを止めて最初の例外を投げる
 *
 * @param items - 処理対象
 * @param limit - 同時実行数の上限
 * @param worker - 要素ごとの処理
 * @throws {RangeError} limitが1未満の場合
 */
export async function runWithConcurrency<T>(
    items: readonly T[],
    limit: number,
    worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
    if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError(`limit must be a positive integer: ${limit}`);
    }

    let nextIndex = 0;
    let isFailed = false;

    const runner = async (): Promise<void> => {
        while (!isFailed && nextIndex < items.length) {
            const index = nextIndex++;
            try {
                await worker(items[index] as T, index);
            } catch (error) {
                isFailed = true;
                throw error;
            }
        }
    };

    const runners = Array.from({ length: Math.min(limit, items.length) }, () => runner());
    await Promise.all(runners);
}

/**
 * 指定時間待機する
 *
 * @param milliseconds - 待機時間(ミリ秒)
 */
export function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
