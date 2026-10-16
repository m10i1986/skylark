//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { CliUsageError, parseCliArguments } from "../src/cli-args.ts";

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
            isDebug: false,
            isHelp: false,
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
});
