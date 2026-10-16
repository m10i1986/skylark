//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

/** 有効期限と最大件数を持つキャッシュ */
export type TtlCache<TKey, TValue> = {
    get(key: TKey): TValue | undefined;
    set(key: TKey, value: TValue): void;
    // キャッシュにあればそれを返し 無ければ取得して保存する
    getOrLoad(key: TKey, load: () => Promise<TValue>): Promise<TValue>;
};

/**
 * 取得結果を一定時間保持するキャッシュを作る
 *
 * 同じキーの取得が同時に走った場合は1回にまとめる 件数が上限を超えたら古いものから捨てる
 *
 * @param ttlMilliseconds - 保持時間
 * @param maxEntries - 最大件数
 * @param now - 現在時刻を返す関数(テスト用)
 * @returns キャッシュ
 */
export function createTtlCache<TKey, TValue>(
    ttlMilliseconds: number,
    maxEntries: number,
    now: () => number = Date.now,
): TtlCache<TKey, TValue> {
    const entries = new Map<TKey, { value: TValue; expiresAt: number }>();
    const loading = new Map<TKey, Promise<TValue>>();

    const get = (key: TKey): TValue | undefined => {
        const entry = entries.get(key);
        if (entry == null) {
            return undefined;
        }
        if (entry.expiresAt <= now()) {
            entries.delete(key);
            return undefined;
        }
        return entry.value;
    };

    const set = (key: TKey, value: TValue): void => {
        entries.delete(key);
        entries.set(key, { value, expiresAt: now() + ttlMilliseconds });
        while (entries.size > maxEntries) {
            const oldest = entries.keys().next();
            if (oldest.done === true) {
                break;
            }
            entries.delete(oldest.value);
        }
    };

    return {
        get,
        set,
        async getOrLoad(key, load) {
            const cached = get(key);
            if (cached !== undefined) {
                return cached;
            }
            const inFlight = loading.get(key);
            if (inFlight != null) {
                return inFlight;
            }
            const promise = load()
                .then((value) => {
                    set(key, value);
                    return value;
                })
                .finally(() => {
                    loading.delete(key);
                });
            loading.set(key, promise);
            return promise;
        },
    };
}
