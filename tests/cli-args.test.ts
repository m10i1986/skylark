//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { CliUsageError, DEFAULT_HISTORY_SINCE, MAX_AI_BOX_RACES, parseCliArguments } from "../src/cli-args.ts";
import { DEFAULT_VALUE_CRITERIA } from "../src/predict/value.ts";

describe("parseCliArguments", () => {
    test("uses the same defaults as the original argparse definition", () => {
        expect(parseCliArguments([])).toEqual({
            temp: "./temp",
            raceListFile: "race_list.txt",
            periodOfMonths: 12,
            isRebuildAllTables: false,
            isRebuildFeature: false,
            isUpdateRaceList: false,
            isScraping: false,
            isFeature: false,
            isTrain: false,
            isPredict: false,
            isAiBox: false,
            isReport: false,
            isVerbose: false,
            isDebug: false,
            isHelp: false,
            date: null,
            historySince: DEFAULT_HISTORY_SINCE,
            valueCriteria: DEFAULT_VALUE_CRITERIA,
            boxMaxTickets: 60,
            raceIds: [],
        });
    });

    test("accepts the documented -U -S -F combination", () => {
        const args = parseCliArguments(["-U", "-S", "-F"]);
        expect(args).toMatchObject({ isUpdateRaceList: true, isScraping: true, isFeature: true });
    });

    test("accepts clustered short options", () => {
        const args = parseCliArguments(["-USF"]);
        expect(args).toMatchObject({ isUpdateRaceList: true, isScraping: true, isFeature: true });
    });

    test("accepts the two letter short option -Rf", () => {
        expect(parseCliArguments(["-Rf"]).isRebuildFeature).toBe(true);
        expect(parseCliArguments(["--rebuild-feature"]).isRebuildFeature).toBe(true);
    });

    test("takes positional race ids", () => {
        const args = parseCliArguments(["-S", "202501010101", "202501010102"]);
        expect(args.raceIds).toEqual(["202501010101", "202501010102"]);
    });

    test("parses value options in both spellings", () => {
        const args = parseCliArguments(["--temp", "/tmp/x", "--race-list-file=list.txt", "--period-of-months", "3"]);
        expect(args).toMatchObject({ temp: "/tmp/x", raceListFile: "list.txt", periodOfMonths: 3 });
    });

    test("parses flags", () => {
        const args = parseCliArguments(["--rebuild-all-tables", "--debug", "-h"]);
        expect(args).toMatchObject({ isRebuildAllTables: true, isDebug: true, isHelp: true });
    });

    test("rejects an unknown option", () => {
        expect(() => parseCliArguments(["--nope"])).toThrow(CliUsageError);
    });

    test("rejects a non integer period", () => {
        expect(() => parseCliArguments(["--period-of-months", "many"])).toThrow(CliUsageError);
        expect(() => parseCliArguments(["--period-of-months", "1.5"])).toThrow(CliUsageError);
    });

    test("rejects a value option without a value", () => {
        expect(() => parseCliArguments(["--temp"])).toThrow(CliUsageError);
    });

    test("parses the train, predict and report modes", () => {
        expect(parseCliArguments(["-T"]).isTrain).toBe(true);
        expect(parseCliArguments(["--train"]).isTrain).toBe(true);
        expect(parseCliArguments(["-P", "202605040711"])).toMatchObject({
            isPredict: true,
            raceIds: ["202605040711"],
        });
        expect(parseCliArguments(["--report", "--date", "2026-10-18"])).toMatchObject({
            isReport: true,
            date: "2026-10-18",
        });
    });

    test("parses the value criteria", () => {
        const args = parseCliArguments([
            "-P",
            "--min-odds",
            "15.5",
            "--min-popularity",
            "6",
            "--max-rank=3",
            "--min-ev",
            "0",
        ]);
        expect(args.valueCriteria).toEqual({ minOdds: 15.5, minPopularity: 6, maxModelRank: 3, minExpectedValue: 0 });
    });

    test("rejects invalid criteria", () => {
        expect(() => parseCliArguments(["--min-odds", "0.5"])).toThrow(CliUsageError);
        expect(() => parseCliArguments(["--min-odds", "abc"])).toThrow(CliUsageError);
        expect(() => parseCliArguments(["--min-popularity", "0"])).toThrow(CliUsageError);
        expect(() => parseCliArguments(["--max-rank", "2.5"])).toThrow(CliUsageError);
        expect(() => parseCliArguments(["--min-ev", "-1"])).toThrow(CliUsageError);
    });

    test("rejects a date that does not exist", () => {
        expect(() => parseCliArguments(["--date", "2026-02-30"])).toThrow(CliUsageError);
        expect(() => parseCliArguments(["--date", "20261018"])).toThrow(CliUsageError);
        expect(() => parseCliArguments(["--history-since", "yesterday"])).toThrow(CliUsageError);
    });

    describe("the AI box mode (-B)", () => {
        test("takes the race ids to propose boxes for, in both spellings", () => {
            expect(parseCliArguments(["-B", "202605040711"])).toMatchObject({
                isAiBox: true,
                boxMaxTickets: 60,
                raceIds: ["202605040711"],
            });
            expect(parseCliArguments(["--ai-box", "202605040711"]).isAiBox).toBe(true);
        });

        test("requires at least one race id, because every race calls the paid API", () => {
            expect(() => parseCliArguments(["-B"])).toThrow(CliUsageError);
            expect(() => parseCliArguments(["-P", "-B"])).toThrow(CliUsageError);
        });

        test("accepts up to the limit of races and rejects more", () => {
            const ids = (count: number): string[] =>
                Array.from({ length: count }, (_, index) => String(202605040701 + index));
            expect(parseCliArguments(["-B", ...ids(MAX_AI_BOX_RACES)]).raceIds).toHaveLength(MAX_AI_BOX_RACES);
            expect(() => parseCliArguments(["-B", ...ids(MAX_AI_BOX_RACES + 1)])).toThrow(CliUsageError);
        });

        test("does not limit the race ids of the other modes", () => {
            const ids = Array.from({ length: 50 }, (_, index) => String(202605040701 + index));
            expect(parseCliArguments(["-P", ...ids]).raceIds).toHaveLength(50);
        });

        test("parses the ticket limit between 3 horses (6) and 8 horses (336)", () => {
            expect(parseCliArguments(["-B", "--box-max-tickets", "24", "1"]).boxMaxTickets).toBe(24);
            expect(parseCliArguments(["-B", "--box-max-tickets=336", "1"]).boxMaxTickets).toBe(336);
            expect(parseCliArguments(["-B", "--box-max-tickets=6", "1"]).boxMaxTickets).toBe(6);
        });

        test.each(["5", "337", "0", "-24", "2.5", "abc", ""])("rejects the ticket limit %p", (value) => {
            expect(() => parseCliArguments(["-B", `--box-max-tickets=${value}`, "1"])).toThrow(CliUsageError);
        });
    });
});
