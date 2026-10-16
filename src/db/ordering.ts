//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

/** レコードを識別する主キーの構成要素 */
export type KeyPart = string | number;

function compareKeys(left: readonly KeyPart[], right: readonly KeyPart[]): number {
    for (const [position, leftPart] of left.entries()) {
        const rightPart = right[position];
        if (rightPart == null || leftPart === rightPart) {
            continue;
        }
        // 型が混在する場合は数値を先にする(主キー列は常に同じ型なので実際には起きない)
        if (typeof leftPart !== typeof rightPart) {
            return typeof leftPart === "number" ? -1 : 1;
        }
        return leftPart < rightPart ? -1 : 1;
    }
    return left.length - right.length;
}

/**
 * 主キーで重複を除き 主キーの昇順に並べる
 *
 * 共有テーブルへ並行して複数行をINSERTすると 行の並びが処理ごとに異なる場合にデッドロックする
 * すべての書き込みで行の並びを統一して ロックの取得順を揃えるために使う
 *
 * @param records - 登録するレコード
 * @param keyOf - レコードの主キー
 * @param keep - 主キーが重複した場合に残す方 first=先に現れた方 last=後に現れた方
 * @returns 重複を除いた昇順のレコード
 */
export function uniqueSortedByKey<T>(
    records: readonly T[],
    keyOf: (record: T) => readonly KeyPart[],
    keep: "first" | "last" = "first",
): T[] {
    const byKey = new Map<string, { record: T; key: readonly KeyPart[] }>();
    for (const record of records) {
        const key = keyOf(record);
        const identity = JSON.stringify(key);
        if (keep === "last" || !byKey.has(identity)) {
            byKey.set(identity, { record, key });
        }
    }
    return [...byKey.values()].sort((a, b) => compareKeys(a.key, b.key)).map((entry) => entry.record);
}
