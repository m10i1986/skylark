//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { buildHistoryState, buildRaceSamples } from "../src/predict/dataset.ts";
import { circuitOfRaceId, FEATURE_NAMES, HistoryState, startersOf } from "../src/predict/history.ts";
import { jraRaceId, race, runner } from "./predict-fixtures.ts";

// 特徴量の値を名前で引く
function featureOf(row: number[] | undefined, name: (typeof FEATURE_NAMES)[number]): number {
    const value = row?.[FEATURE_NAMES.indexOf(name)];
    if (value == null) {
        throw new Error(`missing feature ${name}`);
    }
    return value;
}

describe("circuitOfRaceId", () => {
    test("treats venue codes 01 to 10 as central and the rest as local", () => {
        expect(circuitOfRaceId(202605040711)).toBe("jra");
        expect(circuitOfRaceId(202610010101)).toBe("jra");
        expect(circuitOfRaceId(202630052005)).toBe("local");
        expect(circuitOfRaceId(202655040410)).toBe("local");
    });
});

describe("startersOf", () => {
    test("excludes scratched horses that have no win odds", () => {
        const scratched = runner(3, { odds: null, popularity: null, orderOfFinish: null });
        const target = race(jraRaceId(1), "2026-01-10", [runner(1), runner(2), scratched]);
        expect(startersOf(target).map((starter) => starter.horseNumber)).toEqual([1, 2]);
    });

    test("keeps a horse that ran but has no finishing order", () => {
        const stopped = runner(3, { orderOfFinish: null });
        const target = race(jraRaceId(1), "2026-01-10", [runner(1), runner(2), stopped]);
        expect(startersOf(target)).toHaveLength(3);
    });
});

describe("HistoryState", () => {
    test("gives a first-time starter the prior values and the debut flag", () => {
        const state = new HistoryState();
        const [row] = state.featureRows(race(jraRaceId(1), "2026-01-10", [runner(1), runner(2)]));
        expect(featureOf(row, "log_starts")).toBe(0);
        expect(featureOf(row, "is_debut")).toBe(1);
        expect(featureOf(row, "win_rate")).toBeCloseTo(0.075, 12);
        expect(featureOf(row, "jockey_win_rate")).toBeCloseTo(0.075, 12);
        expect(featureOf(row, "log_days_since_last")).toBe(0);
    });

    test("uses past results of the same horse, jockey and trainer", () => {
        const state = new HistoryState();
        state.applyRace(
            race(jraRaceId(1), "2026-01-10", [runner(1, { orderOfFinish: 1 }), runner(2, { orderOfFinish: 2 })]),
        );
        const next = race(jraRaceId(2), "2026-01-24", [runner(1), runner(2)]);
        const [winner, loser] = state.featureRows(next);

        // 1着1回: (1 + 0.075 x 3) / (1 + 3)
        expect(featureOf(winner, "win_rate")).toBeCloseTo((1 + 0.075 * 3) / 4, 12);
        expect(featureOf(loser, "win_rate")).toBeCloseTo((0 + 0.075 * 3) / 4, 12);
        expect(featureOf(winner, "is_debut")).toBe(0);
        expect(featureOf(winner, "log_starts")).toBeCloseTo(Math.log1p(1), 12);
        // 14日ぶり
        expect(featureOf(winner, "log_days_since_last")).toBeCloseTo(Math.log1p(14), 12);
        // 騎手は50回で寄せるため 1勝でも率はほとんど動かない
        expect(featureOf(winner, "jockey_win_rate")).toBeCloseTo((1 + 0.075 * 50) / 51, 12);
        expect(featureOf(loser, "jockey_win_rate")).toBeCloseTo((0 + 0.075 * 50) / 51, 12);
    });

    test("does not count a scratched horse as a start", () => {
        const state = new HistoryState();
        const scratched = runner(2, { odds: null, popularity: null, orderOfFinish: null });
        state.applyRace(race(jraRaceId(1), "2026-01-10", [runner(1), scratched, runner(3)]));
        const [row] = state.featureRows(race(jraRaceId(2), "2026-01-24", [runner(2), runner(1)]));
        expect(featureOf(row, "is_debut")).toBe(1);
        expect(featureOf(row, "log_starts")).toBe(0);
    });

    test("measures the last three furlongs relative to the median of that race", () => {
        const state = new HistoryState();
        const slow = runner(1, { lastPhase: 36 });
        const median = runner(2, { lastPhase: 35 });
        const fast = runner(3, { lastPhase: 34 });
        state.applyRace(race(jraRaceId(1), "2026-01-10", [slow, median, fast]));
        const rows = state.featureRows(race(jraRaceId(2), "2026-01-24", [runner(1), runner(3)]));
        // 相対値 +1.0 と -1.0 を 1走ぶんの重み n/(n+1) = 0.5 で寄せる
        expect(featureOf(rows[0], "recent_last_phase")).toBeCloseTo(0.5, 12);
        expect(featureOf(rows[1], "recent_last_phase")).toBeCloseTo(-0.5, 12);
    });

    test("keeps the surface aptitude relative to the horse's own record", () => {
        const state = new HistoryState();
        // 芝で3着以内 ダートで着外
        state.applyRace(
            race(jraRaceId(1), "2026-01-10", [runner(1, { orderOfFinish: 1 }), runner(2), runner(3), runner(4)]),
        );
        state.applyRace(
            race(jraRaceId(2), "2026-01-17", [runner(1, { orderOfFinish: 4 }), runner(2), runner(3), runner(4)], {
                trackSurface: "ダート",
            }),
        );
        const turf = state.featureRows(
            race(jraRaceId(3), "2026-02-01", [runner(1), runner(2)], { trackSurface: "芝" }),
        )[0];
        const dirt = state.featureRows(
            race(jraRaceId(3), "2026-02-01", [runner(1), runner(2)], { trackSurface: "ダート" }),
        )[0];
        expect(featureOf(turf, "surface_aptitude")).toBeGreaterThan(0);
        expect(featureOf(dirt, "surface_aptitude")).toBeLessThan(0);
    });

    test("refuses to build features when the history already reaches the race date", () => {
        const state = new HistoryState();
        state.applyRace(race(jraRaceId(1), "2026-01-10", [runner(1), runner(2)]));
        // 同じ日のレースの結果が反映済みだと 当日の結果が特徴量に混ざる
        expect(() => state.featureRows(race(jraRaceId(2), "2026-01-10", [runner(1), runner(2)]))).toThrow(RangeError);
        expect(() => state.featureRows(race(jraRaceId(2), "2026-01-09", [runner(1), runner(2)]))).toThrow(RangeError);
        expect(() => state.featureRows(race(jraRaceId(2), "2026-01-11", [runner(1), runner(2)]))).not.toThrow();
    });

    test("refuses to apply races out of date order", () => {
        const state = new HistoryState();
        state.applyRace(race(jraRaceId(2), "2026-01-24", [runner(1), runner(2)]));
        expect(() => state.applyRace(race(jraRaceId(1), "2026-01-10", [runner(1), runner(2)]))).toThrow(RangeError);
        expect(state.latestAppliedDate).toBe("2026-01-24");
    });
});

describe("buildRaceSamples", () => {
    test("keeps results of the same day out of that day's features", () => {
        // 同じ日の1Rと2Rに 同じ騎手が騎乗する 2Rの特徴量に1Rの結果が入ってはいけない
        const first = race(jraRaceId(1), "2026-02-01", [
            runner(1, { jockeyId: "same", orderOfFinish: 1 }),
            runner(2, { jockeyId: "other", orderOfFinish: 2 }),
        ]);
        const second = race(jraRaceId(2), "2026-02-01", [
            runner(3, { jockeyId: "same", orderOfFinish: 1 }),
            runner(4, { jockeyId: "other", orderOfFinish: 2 }),
        ]);
        const { samples } = buildRaceSamples([second, first], { sampleFrom: "2026-01-01", circuit: "jra" });
        expect(samples.map((sample) => sample.raceId)).toEqual([first.raceId, second.raceId]);
        const jockeyBefore = featureOf(samples[0]?.features[0], "jockey_win_rate");
        expect(featureOf(samples[1]?.features[0], "jockey_win_rate")).toBe(jockeyBefore);
        expect(jockeyBefore).toBeCloseTo(0.075, 12);
    });

    test("a later day does see the earlier day's results", () => {
        const day1 = race(jraRaceId(1), "2026-02-01", [runner(1, { jockeyId: "same", orderOfFinish: 1 }), runner(2)]);
        const day2 = race(jraRaceId(2), "2026-02-08", [runner(3, { jockeyId: "same", orderOfFinish: 1 }), runner(4)]);
        const { samples } = buildRaceSamples([day1, day2], { sampleFrom: "2026-01-01", circuit: "jra" });
        expect(featureOf(samples[1]?.features[0], "jockey_win_rate")).toBeCloseTo((1 + 0.075 * 50) / 51, 12);
    });

    test("uses the burn-in period only to build history, not as samples", () => {
        const early = race(jraRaceId(1), "2026-01-05", [runner(1, { orderOfFinish: 1 }), runner(2)]);
        const late = race(jraRaceId(2), "2026-02-05", [runner(1), runner(2)]);
        const { samples } = buildRaceSamples([early, late], { sampleFrom: "2026-02-01", circuit: "jra" });
        expect(samples.map((sample) => sample.raceId)).toEqual([late.raceId]);
        expect(featureOf(samples[0]?.features[0], "is_debut")).toBe(0);
    });

    test("skips races that cannot be learned from and restricts to the circuit", () => {
        const noWinner = race(jraRaceId(1), "2026-02-01", [
            runner(1, { orderOfFinish: null }),
            runner(2, { orderOfFinish: 2 }),
        ]);
        const oneRunner = race(jraRaceId(2), "2026-02-02", [runner(1)]);
        const local = race(202630050101, "2026-02-03", [runner(1), runner(2)]);
        const valid = race(jraRaceId(3), "2026-02-04", [runner(1), runner(2)]);
        const { samples } = buildRaceSamples([noWinner, oneRunner, local, valid], {
            sampleFrom: "2026-01-01",
            circuit: "jra",
        });
        expect(samples.map((sample) => sample.raceId)).toEqual([valid.raceId]);
    });

    test("excludes scratched horses from the runners of a sample", () => {
        const scratched = runner(3, { odds: null, popularity: null, orderOfFinish: null });
        const target = race(jraRaceId(1), "2026-02-01", [runner(1), runner(2), scratched]);
        const { samples } = buildRaceSamples([target], { sampleFrom: "2026-01-01", circuit: "jra" });
        expect(samples[0]?.horseNumbers).toEqual([1, 2]);
        expect(samples[0]?.features).toHaveLength(2);
        expect(samples[0]?.isWinners).toEqual([true, false]);
    });

    test("marks every winner of a dead heat", () => {
        const target = race(jraRaceId(1), "2026-02-01", [
            runner(1, { orderOfFinish: 1 }),
            runner(2, { orderOfFinish: 1 }),
            runner(3, { orderOfFinish: 3 }),
        ]);
        const { samples } = buildRaceSamples([target], { sampleFrom: "2026-01-01", circuit: "jra" });
        expect(samples[0]?.isWinners).toEqual([true, true, false]);
    });
});

describe("buildHistoryState", () => {
    test("applies races in date order whatever order they are given", () => {
        const a = race(jraRaceId(1), "2026-01-10", [runner(1, { orderOfFinish: 1 }), runner(2)]);
        const b = race(jraRaceId(2), "2026-01-24", [runner(1, { orderOfFinish: 5 }), runner(2)]);
        const state = buildHistoryState([b, a]);
        expect(state.latestAppliedDate).toBe("2026-01-24");
        const [row] = state.featureRows(race(jraRaceId(3), "2026-02-07", [runner(1), runner(2)]));
        expect(featureOf(row, "log_starts")).toBeCloseTo(Math.log1p(2), 12);
    });
});
