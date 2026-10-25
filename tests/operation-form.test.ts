//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { parseCliArguments } from "../src/cli-args.ts";
import {
    FLAG_FIELDS,
    FLAG_ON,
    MAX_FIELD_CHARS,
    MAX_PERIOD_MONTHS,
    MAX_RACE_IDS,
    MAX_RACE_IDS_CHARS,
    type OperationFormValues,
    TEXT_FIELDS,
} from "../src/webui/operation-fields.ts";
import { buildOperationDefaults, collectFormValues, parseOperationForm } from "../src/webui/operation-form.ts";

const ON = FLAG_ON;

function parsed(values: OperationFormValues) {
    const result = parseOperationForm(values);
    if (!result.ok) {
        throw new Error(`expected a valid form: ${result.errors.join(" / ")}`);
    }
    return result.operation;
}

function errorsOf(values: OperationFormValues): string[] {
    const result = parseOperationForm(values);
    if (result.ok) {
        throw new Error("expected an invalid form");
    }
    return result.errors;
}

describe("parseOperationForm: actions", () => {
    test("needs at least one action", () => {
        expect(errorsOf({})).toEqual(["実行する処理を1つ以上選んでください。"]);
        // 表示や出力の設定だけでは処理にならない
        expect(errorsOf({ verbose: ON, debug: ON })).toHaveLength(1);
    });

    test("builds the same arguments as the command line for -U -S -F", () => {
        const operation = parsed({ updateRaceList: ON, scraping: ON, feature: ON });
        expect(operation.args).toEqual(parseCliArguments(["-U", "-S", "-F"]));
        expect(operation.title).toBe("レース一覧の更新 → ダウンロードと保存 → 特徴量の計算");
        expect(operation.commandLine).toBe("--update-race-list --scraping --feature");
    });

    test("builds the same arguments as the command line for every option", () => {
        const operation = parsed({
            train: ON,
            predict: ON,
            report: ON,
            verbose: ON,
            debug: ON,
            periodOfMonths: "24",
            raceListFile: "list.txt",
            date: "2026-01-31",
            historySince: "2024-04-01",
            minOdds: "12.5",
            minPopularity: "5",
            maxRank: "3",
            minEv: "1.2",
        });
        expect(operation.args).toEqual(
            parseCliArguments([
                "-T",
                "-P",
                "--report",
                "--verbose",
                "--debug",
                "--period-of-months",
                "24",
                "--race-list-file",
                "list.txt",
                "--date",
                "2026-01-31",
                "--history-since",
                "2024-04-01",
                "--min-odds",
                "12.5",
                "--min-popularity",
                "5",
                "--max-rank",
                "3",
                "--min-ev",
                "1.2",
            ]),
        );
    });

    test("uses the command line defaults for blank settings", () => {
        const operation = parsed({ train: ON, minOdds: "  ", historySince: "" });
        expect(operation.args).toEqual(parseCliArguments(["-T"]));
    });

    test("never takes the HTML cache directory from the form", () => {
        const values = collectFormValues({ scraping: ON, temp: "/etc", "--temp": "/etc" });
        expect(parsed(values).args.temp).toBe(parseCliArguments([]).temp);
    });
});

describe("parseOperationForm: destructive operations", () => {
    test("deleting every table needs the confirmation", () => {
        expect(errorsOf({ rebuildAllTables: ON })).toEqual([
            "全テーブルを削除するには、確認欄にチェックしてください。",
        ]);
        expect(errorsOf({ rebuildAllTables: ON, confirmRebuildAllTables: "0" })).toHaveLength(1);
        const operation = parsed({ rebuildAllTables: ON, confirmRebuildAllTables: ON });
        expect(operation.args.isRebuildAllTables).toBe(true);
    });

    test("a confirmation alone does not run anything", () => {
        expect(errorsOf({ confirmRebuildAllTables: ON, confirmRebuildFeature: ON })).toEqual([
            "実行する処理を1つ以上選んでください。",
        ]);
    });

    test("rebuilding the feature table needs its own confirmation", () => {
        // 全テーブルの確認では代わりにならない
        expect(errorsOf({ rebuildFeature: ON, confirmRebuildAllTables: ON })).toEqual([
            "特徴量テーブルを再構築するには、確認欄にチェックしてください。",
        ]);
        const operation = parsed({ rebuildFeature: ON, confirmRebuildFeature: ON });
        expect(operation.args.isRebuildFeature).toBe(true);
    });
});

describe("parseOperationForm: race list file", () => {
    test.each([
        "../outside.txt",
        "/etc/passwd",
        "dir/file.txt",
        "dir\\file.txt",
        "..",
        ".",
        ".hidden",
        "a\0b",
        "name with space",
        "a".repeat(65),
    ])("rejects %j", (raceListFile) => {
        const errors = errorsOf({ updateRaceList: ON, raceListFile });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain("レース一覧のファイル名");
    });

    test("accepts a plain file name", () => {
        expect(parsed({ updateRaceList: ON, raceListFile: "race_list-2.txt" }).args.raceListFile).toBe(
            "race_list-2.txt",
        );
    });
});

describe("parseOperationForm: period of months", () => {
    test.each(["0", "-1", "1.5", "abc", "1e2", String(MAX_PERIOD_MONTHS + 1), "9999", "０１"])(
        "rejects %j",
        (periodOfMonths) => {
            const errors = errorsOf({ updateRaceList: ON, periodOfMonths });
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain("遡る月数");
        },
    );

    test("accepts the range limits", () => {
        expect(parsed({ updateRaceList: ON, periodOfMonths: "1" }).args.periodOfMonths).toBe(1);
        expect(parsed({ updateRaceList: ON, periodOfMonths: String(MAX_PERIOD_MONTHS) }).args.periodOfMonths).toBe(
            MAX_PERIOD_MONTHS,
        );
    });
});

describe("parseOperationForm: AI box", () => {
    test("builds the same arguments as the command line for -B", () => {
        const operation = parsed({ aiBox: ON, boxHorses: "4", raceIds: "202605040711 202605040712" });
        expect(operation.args).toEqual(
            parseCliArguments(["-B", "--box-horses=4", "--", "202605040711", "202605040712"]),
        );
        expect(operation.args).toMatchObject({ isAiBox: true, boxHorses: 4, boxMaxTickets: 24, isPredict: false });
        expect(operation.commandLine).toBe("--ai-box --box-horses=4 -- 202605040711 202605040712");
    });

    test("runs after the prediction and before the report, in the same order as the command line", () => {
        const operation = parsed({ report: ON, aiBox: ON, predict: ON, raceIds: "202605040711" });
        expect(operation.title).toBe("予測と抽出 → 3連単Boxの提案(AI) → 結果の突き合わせ");
        expect(operation.commandLine).toBe("--predict --ai-box --report -- 202605040711");
    });

    test("lets the AI choose the number of horses when the field is empty (the select's default)", () => {
        for (const boxHorses of [undefined, ""]) {
            const operation = parsed({
                aiBox: ON,
                raceIds: "202605040711",
                ...(boxHorses == null ? {} : { boxHorses }),
            });
            expect(operation.args).toMatchObject({ boxHorses: null, boxMaxTickets: 60 });
            expect(operation.commandLine).toBe("--ai-box -- 202605040711");
        }
    });

    test.each([
        ["3", 6],
        ["4", 24],
        ["5", 60],
        ["6", 120],
        ["7", 210],
        ["8", 336],
    ])("makes a box of exactly %s horses (%i tickets)", (horses, tickets) => {
        const operation = parsed({ aiBox: ON, boxHorses: horses, raceIds: "202605040711" });
        expect(operation.args).toMatchObject({ boxHorses: Number(horses), boxMaxTickets: tickets });
        expect(operation.commandLine).toContain(`--box-horses=${horses}`);
        expect(operation.commandLine).not.toContain("--box-max-tickets");
    });

    test("needs race ids, because every race calls the paid API", () => {
        expect(errorsOf({ aiBox: ON })).toEqual(["3連単Boxの提案(-B)には、レース ID を 1 〜 12 件指定してください。"]);
        expect(errorsOf({ aiBox: ON, raceIds: "  " })).toHaveLength(1);
    });

    test("accepts up to the limit of races and rejects more", () => {
        const ids = (count: number): string =>
            Array.from({ length: count }, (_, index) => String(202605040701 + index)).join(" ");
        expect(parsed({ aiBox: ON, raceIds: ids(12) }).args.raceIds).toHaveLength(12);
        expect(errorsOf({ aiBox: ON, raceIds: ids(13) })).toEqual([
            "3連単Boxの提案(-B)には、レース ID を 1 〜 12 件指定してください。",
        ]);
    });

    test.each(["2", "9", "10", "60", "abc", "4.5", "-4", "０"])("rejects the number of horses %j", (value) => {
        const errors = errorsOf({ aiBox: ON, boxHorses: value, raceIds: "202605040711" });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain("Box の頭数は 3 〜 8");
    });

    test("never lets the number of horses become an option", () => {
        const errors = errorsOf({ aiBox: ON, boxHorses: "--debug", raceIds: "202605040711" });
        expect(errors[0]).toContain("Box の頭数は 3 〜 8");
    });

    test("ignores the number of horses unless the AI box is chosen, because a browser always sends the select", () => {
        const operation = parsed({ updateRaceList: ON, boxHorses: "5" });
        expect(operation.commandLine).toBe("--update-race-list");
        expect(operation.args).toMatchObject({ boxHorses: null, boxMaxTickets: 60 });
        // 他の処理では 値が誤りでも止めない
        expect(parsed({ train: ON, boxHorses: "99" }).commandLine).toBe("--train");
    });

    test("reads the number of horses of a browser submission with the AI box chosen", () => {
        const operation = parsed({ aiBox: ON, boxHorses: "7", raceIds: "202605040711" });
        expect(operation.args).toMatchObject({ boxHorses: 7, boxMaxTickets: 210 });
        expect(operation.commandLine).toBe("--ai-box --box-horses=7 -- 202605040711");
    });

    test("takes the number of horses from the form, and drops the old ticket limit field", () => {
        expect(collectFormValues({ boxMaxTickets: "24", boxHorses: "4" })).toEqual({ boxHorses: "4" });
    });
});

describe("parseOperationForm: race ids", () => {
    test("splits ids by spaces, line breaks and commas", () => {
        const operation = parsed({ scraping: ON, raceIds: "202501010101, 202501010102\n202501010103\t202501010104" });
        expect(operation.args.raceIds).toEqual(["202501010101", "202501010102", "202501010103", "202501010104"]);
        expect(operation.commandLine).toBe("--scraping -- 202501010101 202501010102 202501010103 202501010104");
    });

    test("works for prediction too", () => {
        expect(parsed({ predict: ON, raceIds: "202605040701" }).args.raceIds).toEqual(["202605040701"]);
    });

    test.each(["abc", "-5", "--rebuild-all-tables", "-S", "1;2", "12.5", "1".repeat(19), "２０２５"])(
        "rejects %j so that it can never become an option",
        (raceId) => {
            const errors = errorsOf({ scraping: ON, raceIds: `202501010101 ${raceId}` });
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain("レース ID");
        },
    );

    test("rejects ids when nothing uses them", () => {
        const errors = errorsOf({ feature: ON, raceIds: "202501010101" });
        expect(errors).toEqual(["レース ID は、ダウンロード(-S)か予測(-P)かBoxの提案(-B)と一緒に指定してください。"]);
    });

    test("limits the number of ids", () => {
        const ids = (count: number): string[] => Array.from({ length: count }, (_, i) => String(202500000000 + i));
        expect(parsed({ scraping: ON, raceIds: ids(MAX_RACE_IDS).join(" ") }).args.raceIds).toHaveLength(MAX_RACE_IDS);
        expect(errorsOf({ scraping: ON, raceIds: ids(MAX_RACE_IDS + 1).join(" ") })).toEqual([
            `レース ID は ${MAX_RACE_IDS} 件までです。`,
        ]);
    });

    test("limits the length of the input", () => {
        const values = collectFormValues({ scraping: ON, raceIds: "1 ".repeat(MAX_RACE_IDS_CHARS) });
        expect(errorsOf(values)).toEqual([`レース ID は ${MAX_RACE_IDS} 件までです。`]);
    });
});

describe("parseOperationForm: values checked like the command line", () => {
    test("reports the same errors as parseCliArguments", () => {
        expect(errorsOf({ predict: ON, minOdds: "abc" })[0]).toContain("--min-odds");
        expect(errorsOf({ predict: ON, minOdds: "0.5" })[0]).toContain("at least 1");
        expect(errorsOf({ predict: ON, minPopularity: "0" })[0]).toContain("--min-popularity");
        expect(errorsOf({ predict: ON, maxRank: "x" })[0]).toContain("--max-rank");
        expect(errorsOf({ predict: ON, minEv: "-1" })[0]).toContain("--min-ev");
        expect(errorsOf({ report: ON, date: "2026-02-30" })[0]).toContain("--date");
        expect(errorsOf({ train: ON, historySince: "yesterday" })[0]).toContain("--history-since");
    });

    test("a value that looks like an option is a value, not an option", () => {
        const errors = errorsOf({ predict: ON, minOdds: "--debug" });
        expect(errors[0]).toContain("--min-odds");
    });

    test("rejects overlong values", () => {
        const values = collectFormValues({ report: ON, date: "2".repeat(500) });
        expect(errorsOf(values)).toEqual(["--date の値が長すぎます。"]);
    });
});

describe("collectFormValues", () => {
    test("keeps only the known fields as strings", () => {
        const file = new File(["x"], "x.txt");
        const values = collectFormValues({
            scraping: ON,
            feature: "on",
            train: "",
            raceIds: "1 2",
            date: file,
            unknown: "x",
            __proto__: { debug: ON },
            constructor: "x",
        });
        expect(values).toEqual({ scraping: ON, raceIds: "1 2" });
    });

    test("accepts a checkbox only when it carries the expected value", () => {
        const values = collectFormValues(Object.fromEntries(FLAG_FIELDS.map((name) => [name, "true"])));
        expect(values).toEqual({});
    });

    test("bounds the length of every field", () => {
        const long = "x".repeat(100_000);
        const values = collectFormValues(Object.fromEntries(TEXT_FIELDS.map((name) => [name, long])));
        for (const name of TEXT_FIELDS) {
            const limit = name === "raceIds" ? MAX_RACE_IDS_CHARS : MAX_FIELD_CHARS;
            expect(values[name]?.length).toBe(limit + 1);
        }
    });
});

describe("buildOperationDefaults", () => {
    test("shows the defaults of the command line", () => {
        const defaults = buildOperationDefaults("./temp");
        const cli = parseCliArguments([]);
        expect(defaults).toEqual({
            periodOfMonths: cli.periodOfMonths,
            raceListFile: cli.raceListFile,
            historySince: cli.historySince,
            minOdds: cli.valueCriteria.minOdds,
            minPopularity: cli.valueCriteria.minPopularity,
            maxRank: cli.valueCriteria.maxModelRank,
            minExpectedValue: cli.valueCriteria.minExpectedValue,
            tempDirectory: "./temp",
        });
    });
});
