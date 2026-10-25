//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { buildHorseForm, condenseRaceClass, courseOf, type PastRun } from "../src/predict/form.ts";

// テスト用の過去の1走 引数で上書きしない項目は標準の値になる
function pastRun(date: string, overrides: Partial<PastRun> = {}): PastRun {
    return {
        raceId: 202605040701,
        date,
        raceName: "テスト特別",
        course: "東京",
        raceClass: "3歳オープン",
        trackSurface: "芝",
        distance: 2000,
        trackCondition: "良",
        fieldSize: 16,
        orderOfFinish: 1,
        popularity: 1,
        odds: 2.5,
        margin: "",
        finishingTime: "00:02:00.0",
        lastPhase: 34.5,
        lastPhaseRank: 1,
        passingRank: "3-3",
        jockeyName: "騎手",
        basisWeight: 56,
        horseWeight: 480,
        horseWeightDiff: 0,
        ...overrides,
    };
}

describe("courseOf", () => {
    test("開催の表記から回数と日目を除いて開催場を取り出す", () => {
        expect(courseOf("4回阪神7日目")).toBe("阪神");
        expect(courseOf("4回 京都 9日目")).toBe("京都");
        expect(courseOf("2回東京12日目")).toBe("東京");
    });

    test("回数や日目が無ければそのまま 空なら null", () => {
        expect(courseOf("東京")).toBe("東京");
        expect(courseOf("")).toBeNull();
        expect(courseOf("4回 9日目")).toBeNull();
    });
});

describe("condenseRaceClass", () => {
    test("括弧や2つ以上の空白の手前までにする", () => {
        expect(condenseRaceClass("3歳オープン  (国際) 牡・牝(指)(馬齢)")).toBe("3歳オープン");
        expect(condenseRaceClass("3歳未勝利  牝[指](馬齢)")).toBe("3歳未勝利");
        expect(condenseRaceClass("3歳以上1勝クラス  (混)[指](定量)")).toBe("3歳以上1勝クラス");
        expect(condenseRaceClass("2歳新馬  [指](馬齢)")).toBe("2歳新馬");
    });

    test("条件が読み取れない表記や空は null にする", () => {
        expect(condenseRaceClass("(馬齢)")).toBeNull();
        expect(condenseRaceClass("")).toBeNull();
        expect(condenseRaceClass(null)).toBeNull();
    });
});

describe("buildHorseForm", () => {
    const target = { date: "2026-10-25", trackSurface: "芝", distance: 3000 };

    test("通算と同じ馬場と近い距離の成績を数える 着順の無い出走も出走数に含める", () => {
        const runs = [
            pastRun("2026-09-21", { distance: 2400, orderOfFinish: 1 }),
            pastRun("2026-05-31", { distance: 2400, orderOfFinish: 3 }),
            pastRun("2026-04-19", { distance: 2000, orderOfFinish: null }),
            pastRun("2026-02-15", { distance: 1800, trackSurface: "ダ", orderOfFinish: 2 }),
            pastRun("2025-12-27", { distance: 2800, orderOfFinish: 5 }),
        ];

        const form = buildHorseForm(runs, target);

        expect(form.career).toEqual({ starts: 5, wins: 1, top3: 3 });
        expect(form.sameSurface).toEqual({ starts: 4, wins: 1, top3: 2 });
        // 3000m の ±200m は 2800m だけ
        expect(form.nearDistance).toEqual({ starts: 1, wins: 0, top3: 0 });
        expect(form.longestDistance).toBe(2800);
    });

    test("距離の近さは 200m の差を含み 201m の差は含まない", () => {
        const form = buildHorseForm(
            [pastRun("2026-09-21", { distance: 3200 }), pastRun("2026-08-21", { distance: 3201 })],
            target,
        );
        expect(form.nearDistance?.starts).toBe(1);
    });

    test("前走からの日数と距離の増減を求める", () => {
        const form = buildHorseForm([pastRun("2026-09-21", { distance: 2400 })], target);
        expect(form.daysSinceLast).toBe(34);
        expect(form.distanceChange).toBe(600);
    });

    test("直近の出走は新しい順のまま指定の数だけ残す", () => {
        const runs = Array.from({ length: 8 }, (_, index) => pastRun(`2026-0${8 - index}-01`));
        expect(buildHorseForm(runs, target).recentRuns.map((run) => run.date)).toEqual(
            runs.slice(0, 5).map((r) => r.date),
        );
        expect(buildHorseForm(runs, target, 2).recentRuns).toHaveLength(2);
    });

    test("出走が無い馬は 出走数0で 前走に関する値を持たない", () => {
        const form = buildHorseForm([], target);
        expect(form.career).toEqual({ starts: 0, wins: 0, top3: 0 });
        expect(form.sameSurface).toEqual({ starts: 0, wins: 0, top3: 0 });
        expect(form.longestDistance).toBeNull();
        expect(form.daysSinceLast).toBeNull();
        expect(form.distanceChange).toBeNull();
        expect(form.recentRuns).toEqual([]);
    });

    test("今回の馬場や距離が分からなければ それに関する成績は null にする", () => {
        const form = buildHorseForm([pastRun("2026-09-21")], {
            date: "2026-10-25",
            trackSurface: null,
            distance: null,
        });
        expect(form.sameSurface).toBeNull();
        expect(form.nearDistance).toBeNull();
        expect(form.distanceChange).toBeNull();
        expect(form.career.starts).toBe(1);
    });
});
