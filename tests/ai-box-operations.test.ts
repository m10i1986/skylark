//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";

import { parseCliArguments } from "../src/cli-args.ts";
import { ConfigError } from "../src/config.ts";
import { SkylarkCrud } from "../src/db/crud.ts";
import { PredictionRepository } from "../src/db/prediction-repository.ts";
import { type DatabaseHandle, type NetkeibaClientLease, runOperations } from "../src/operations.ts";
import { BoxSelectionError, type BoxSelectionRequest, type BoxSelector } from "../src/predict/ai-box.ts";
import { FEATURE_NAMES } from "../src/predict/history.ts";
import { formatLocalDate } from "../src/predict/live.ts";
import type { ModelParameters } from "../src/predict/model.ts";
import { addDays } from "../src/predict/train.ts";
import type { HorseEntry, NetkeibaClient, RaceInformation, RaceListItem } from "../src/webui/netkeiba-client.ts";
import { createRecordingLogger } from "./mock-fetch.ts";
import { jraRaceId } from "./predict-fixtures.ts";
import { createTestDatabase, resultRecord, type TestDatabase } from "./test-database.ts";

// 実行時の今日 operations.ts は現在時刻を差し替えられないため テストも実際の今日を使う
const TODAY = formatLocalDate(new Date());
const YESTERDAY = addDays(TODAY, -1);

let db: TestDatabase;
let closeDatabase: () => Promise<void>;
let crud: SkylarkCrud;
let repository: PredictionRepository;
let tempDirectory: string;

beforeAll(async () => {
    const created = await createTestDatabase();
    db = created.db;
    closeDatabase = created.close;
    crud = new SkylarkCrud(db, createRecordingLogger());
    repository = new PredictionRepository(db);
});

afterAll(async () => {
    await closeDatabase();
});

beforeEach(async () => {
    await crud.truncateAllTables();
    await db.execute(
        sql`TRUNCATE TABLE box_proposal_tbl, prediction_tbl, prediction_model_tbl RESTART IDENTITY CASCADE`,
    );
    await crud.insertHorses(
        Array.from({ length: 8 }, (_, index) => ({ id: 5001 + index, horseName: `馬${index + 1}` })),
    );
    tempDirectory = await mkdtemp(path.join(tmpdir(), "skylark-ai-box-"));
});

afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
});

function horseEntry(horseNumber: number, overrides: Partial<HorseEntry> = {}): HorseEntry {
    return {
        horseId: 5000 + horseNumber,
        horseNumber,
        wakuNumber: 1,
        horseName: `馬${horseNumber}`,
        barei: "牡4",
        basisWeight: 56,
        jockeyId: "01001",
        jockeyName: `騎手${horseNumber}`,
        trainerId: "01002",
        trainerName: "調教師",
        odds: 2 + horseNumber * 3,
        popularity: horseNumber,
        horseWeight: 480,
        horseWeightDiff: 2,
        ...overrides,
    };
}

function information(raceId: number, horses: HorseEntry[], raceName: string): RaceInformation {
    return {
        race: { id: raceId, raceName, raceNumber: 1, distance: 1600, trackSurface: "芝", postTime: "15:20" },
        horses,
    };
}

function listItem(raceId: number, raceName: string): RaceListItem {
    return {
        courseName: "東京",
        raceNumber: "1R",
        raceName,
        text: raceName,
        href: `/race/shutuba.html?race_id=${raceId}`,
        raceId,
    };
}

function fakeClient(races: Array<{ raceId: number; name: string; horses: HorseEntry[] }>): NetkeibaClient {
    return {
        fetchRaceDates: async () => [{ text: TODAY, href: `race_list.html?kaisai_date=${TODAY}`, kaisaiDate: TODAY }],
        fetchRaceList: async () => races.map((race) => listItem(race.raceId, race.name)),
        fetchRaceInformation: async (raceId) => {
            const found = races.find((race) => race.raceId === raceId);
            if (found == null) {
                throw new Error(`unexpected race ${raceId}`);
            }
            return information(raceId, found.horses, found.name);
        },
        close: async () => {},
    };
}

// 6頭立て 人気順に勝率が下がる
const sixHorses = (): HorseEntry[] => Array.from({ length: 6 }, (_, index) => horseEntry(index + 1));

function modelParameters(): ModelParameters {
    return {
        version: 1,
        featureNames: [...FEATURE_NAMES],
        means: FEATURE_NAMES.map(() => 0),
        stds: FEATURE_NAMES.map(() => 1),
        coefficients: FEATURE_NAMES.map(() => 0),
        marketCoefficient: 1,
        l2: 1,
    };
}

async function seedModelAndHistory(): Promise<number> {
    await crud.insertRaceInfo({
        id: jraRaceId(900),
        raceName: "過去",
        date: YESTERDAY,
        distance: 1600,
        trackSurface: "芝",
        raceNumber: 1,
        placeDetail: "東京",
    });
    await crud.insertRaceResults([
        resultRecord(jraRaceId(900), 1, { horseId: 5001, orderOfFinish: 1, odds: 2.5, popularity: 1 }),
        resultRecord(jraRaceId(900), 2, { horseId: 5002, orderOfFinish: 2, odds: 5, popularity: 2 }),
    ]);
    return repository.insertModel({
        circuit: "jra",
        trainFrom: "2025-04-05",
        validFrom: "2026-03-27",
        testFrom: "2026-07-05",
        dataTo: "2026-10-12",
        parameters: modelParameters(),
        metrics: {},
    });
}

// 呼ばれた依頼を記録し 呼ばれるたびに次の応答を返す選定処理
function scriptedSelector(responses: Array<unknown | Error>) {
    const requests: BoxSelectionRequest[] = [];
    const selector: BoxSelector = async (request) => {
        requests.push(request);
        const next = responses[requests.length - 1];
        if (next instanceof Error) {
            throw next;
        }
        return { value: next, model: "claude-opus-5-5" };
    };
    return { requests, selector };
}

function createHarness(client: NetkeibaClient, createSelector: () => BoxSelector) {
    const logger = createRecordingLogger();
    const outputs: string[] = [];
    const events: string[] = [];
    const handle = { closed: 0 };
    return {
        logger,
        outputs,
        events,
        handle,
        run: (argv: string[]) =>
            runOperations(parseCliArguments(["--temp", tempDirectory, ...argv]), {
                logger,
                output: (text) => outputs.push(text),
                env: {},
                openDatabase: (): DatabaseHandle => ({
                    db,
                    migrate: async () => {},
                    close: async () => {
                        handle.closed++;
                    },
                }),
                acquireNetkeibaClient: async (): Promise<NetkeibaClientLease> => {
                    events.push("acquire");
                    return { client, release: async () => void events.push("release") };
                },
                createBoxSelector: () => {
                    events.push("selector");
                    return createSelector();
                },
            }),
    };
}

// 決まった選定処理を返すハーネス
function harnessWith(client: NetkeibaClient, selector: BoxSelector) {
    return createHarness(client, () => selector);
}

const CHOICE = (horseNumbers: number[]) => ({ horseNumbers, reason: "上位の馬を選んだ", caution: "荒れる場合がある" });

describe("runOperations: -B (AI box)", () => {
    test("predicts the race, asks the selector, saves the proposal and reports it", async () => {
        const modelId = await seedModelAndHistory();
        const raceId = jraRaceId(1);
        const { requests, selector } = scriptedSelector([CHOICE([4, 2, 1, 3])]);
        const harness = harnessWith(fakeClient([{ raceId, name: "本日のS", horses: sixHorses() }]), selector);

        await harness.run(["-B", String(raceId)]);

        // 選定処理を作ってから出馬表を取得し 取得し終えたら選定を依頼する
        expect(harness.events).toEqual(["selector", "acquire", "release"]);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.user).toContain("本日のS");

        const [saved] = await repository.listBoxProposalsWithResults(TODAY);
        expect(saved).toMatchObject({
            modelId,
            raceId,
            source: "ai",
            aiModel: "claude-opus-5-5",
            horseNumbers: [1, 2, 3, 4],
            ticketCount: 24,
            maxTickets: 60,
        });
        // 予測(-P と同じ)も保存される
        expect(await repository.listPredictionsWithResults(TODAY)).toHaveLength(6);

        // -P を付けていないので 予測の報告は出さず Boxの提案だけを出す
        expect(harness.outputs).toHaveLength(1);
        expect(harness.outputs[0]).toContain("3連単Boxの提案");
        expect(harness.outputs[0]).toContain("Box: 1-2-3-4  4頭 24点 2,400円");
        expect(harness.outputs[0]).toContain("選定: AI (claude-opus-5-5)");
        expect(harness.outputs[0]).toContain("上位の馬を選んだ");
        expect(harness.outputs[0]).toContain("荒れる場合がある");
        expect(harness.outputs[0]).toContain("保証しません");
        expect(harness.handle.closed).toBe(1);
    });

    test("with -P, predicts only once and prints both reports", async () => {
        await seedModelAndHistory();
        const raceId = jraRaceId(1);
        const { selector } = scriptedSelector([CHOICE([1, 2, 3])]);
        const harness = harnessWith(fakeClient([{ raceId, name: "本日のS", horses: sixHorses() }]), selector);

        await harness.run(["-P", "-B", String(raceId)]);

        expect(harness.events.filter((event) => event === "acquire")).toHaveLength(1);
        expect(harness.outputs).toHaveLength(2);
        expect(harness.outputs[0]).toContain("予測");
        expect(harness.outputs[1]).toContain("3連単Boxの提案");
    });

    test("passes --box-max-tickets to the selector and the proposal", async () => {
        await seedModelAndHistory();
        const raceId = jraRaceId(1);
        const { requests, selector } = scriptedSelector([CHOICE([1, 2, 3])]);
        const harness = harnessWith(fakeClient([{ raceId, name: "本日のS", horses: sixHorses() }]), selector);

        await harness.run(["-B", "--box-max-tickets", "24", String(raceId)]);

        expect(requests[0]?.user).toContain('"maxTickets":24');
        const [saved] = await repository.listBoxProposalsWithResults(TODAY);
        expect(saved?.maxTickets).toBe(24);
    });

    test("makes the box of exactly the horses given with --box-horses", async () => {
        await seedModelAndHistory();
        const raceId = jraRaceId(1);
        const { requests, selector } = scriptedSelector([CHOICE([1, 2, 3, 4, 5])]);
        const harness = harnessWith(fakeClient([{ raceId, name: "本日のS", horses: sixHorses() }]), selector);

        await harness.run(["-B", "--box-horses", "5", String(raceId)]);

        expect(requests[0]?.user).toContain('"minHorses":5,"maxHorses":5,"maxTickets":60');
        const [saved] = await repository.listBoxProposalsWithResults(TODAY);
        expect(saved).toMatchObject({ source: "ai", horseNumbers: [1, 2, 3, 4, 5], maxTickets: 60 });
        expect(harness.outputs[0]).toContain("3連単Boxの提案");
        expect(harness.outputs[0]).toContain("5頭 60点(6,000円)");
        expect(harness.outputs[0]).not.toContain("点数の上限60点");
    });

    test("does not use an answer with fewer horses than --box-horses", async () => {
        await seedModelAndHistory();
        const raceId = jraRaceId(1);
        // 5頭を指定したのに4頭を返す
        const { selector } = scriptedSelector([CHOICE([1, 2, 3, 4])]);
        const harness = harnessWith(fakeClient([{ raceId, name: "本日のS", horses: sixHorses() }]), selector);

        await harness.run(["-B", "--box-horses=5", String(raceId)]);

        const [saved] = await repository.listBoxProposalsWithResults(TODAY);
        expect(saved).toMatchObject({ source: "fallback", aiModel: null, horseNumbers: [1, 2, 3, 4, 5] });
        expect(harness.outputs[0]).toContain("AIを使えず");
    });

    test("skips the race when fewer horses run than --box-horses", async () => {
        await seedModelAndHistory();
        const raceId = jraRaceId(1);
        const { requests, selector } = scriptedSelector([CHOICE([1, 2, 3, 4, 5, 6, 7])]);
        const harness = harnessWith(fakeClient([{ raceId, name: "本日のS", horses: sixHorses() }]), selector);

        await harness.run(["-B", "--box-horses=7", String(raceId)]);

        expect(requests).toHaveLength(0);
        expect(await repository.listBoxProposalsWithResults(TODAY)).toHaveLength(0);
        expect(harness.outputs[0]).toContain("提案できたレースはありません");
        expect(harness.logger.ofLevel("warning").some((message) => message.includes("no box can be made"))).toBe(true);
    });

    test("switches to the best hit probability box when the answer is invalid, and says so", async () => {
        await seedModelAndHistory();
        const raceId = jraRaceId(1);
        const { selector } = scriptedSelector([CHOICE([1, 2, 99])]);
        const harness = harnessWith(fakeClient([{ raceId, name: "本日のS", horses: sixHorses() }]), selector);

        await harness.run(["-B", String(raceId)]);

        const [saved] = await repository.listBoxProposalsWithResults(TODAY);
        expect(saved).toMatchObject({ source: "fallback", aiModel: null, horseNumbers: [1, 2, 3, 4, 5] });
        expect(saved?.horseNumbers).toEqual(saved?.baselineHorseNumbers);
        expect(harness.outputs[0]).toContain("AIを使えず");
        expect(harness.logger.ofLevel("warning").some((message) => message.includes("AI box was not used"))).toBe(true);
    });

    test("an authentication failure stops the run, but the proposals already made are saved and reported", async () => {
        await seedModelAndHistory();
        const first = jraRaceId(1);
        const second = jraRaceId(2);
        const { selector } = scriptedSelector([
            CHOICE([1, 2, 3, 4]),
            new BoxSelectionError("Claude API authentication failed", false),
        ]);
        const harness = harnessWith(
            fakeClient([
                { raceId: first, name: "1レース目", horses: sixHorses() },
                { raceId: second, name: "2レース目", horses: sixHorses() },
            ]),
            selector,
        );

        await expect(harness.run(["-B", String(first), String(second)])).rejects.toThrow("authentication failed");

        expect((await repository.listBoxProposalsWithResults(TODAY)).map((row) => row.raceId)).toEqual([first]);
        expect(harness.outputs).toHaveLength(1);
        expect(harness.outputs[0]).toContain("1レース目");
        expect(harness.handle.closed).toBe(1);
    });

    test("reports the races it could not propose, such as a race with fewer than 3 starters", async () => {
        await seedModelAndHistory();
        const full = jraRaceId(1);
        const small = jraRaceId(2);
        const { requests, selector } = scriptedSelector([CHOICE([1, 2, 3])]);
        const harness = harnessWith(
            fakeClient([
                { raceId: full, name: "通常", horses: sixHorses() },
                { raceId: small, name: "少頭数", horses: [horseEntry(1), horseEntry(2)] },
            ]),
            selector,
        );

        await harness.run(["-B", String(full), String(small)]);

        expect(requests).toHaveLength(1);
        expect(harness.outputs[0]).toContain(`提案できなかったレース: ${small}`);
    });

    test("fails before borrowing the browser when the selector cannot be created", async () => {
        await seedModelAndHistory();
        const raceId = jraRaceId(1);
        const harness = createHarness(fakeClient([{ raceId, name: "本日のS", horses: sixHorses() }]), () => {
            throw new ConfigError("AI_BOX_TIMEOUT must be a number");
        });

        await expect(harness.run(["-B", String(raceId)])).rejects.toThrow("AI_BOX_TIMEOUT");

        expect(harness.events).toEqual(["selector"]);
        expect(harness.handle.closed).toBe(1);
    });

    test("does not create the selector unless -B is given", async () => {
        await seedModelAndHistory();
        const raceId = jraRaceId(1);
        const { selector } = scriptedSelector([]);
        const harness = harnessWith(fakeClient([{ raceId, name: "本日のS", horses: sixHorses() }]), selector);

        await harness.run(["-P", String(raceId)]);

        expect(harness.events).toEqual(["acquire", "release"]);
    });

    test("--report compares the saved proposal with the trifecta result and the baseline box", async () => {
        await seedModelAndHistory();
        const raceId = jraRaceId(1);
        const { selector } = scriptedSelector([CHOICE([1, 2, 3, 4])]);
        const harness = harnessWith(fakeClient([{ raceId, name: "本日のS", horses: sixHorses() }]), selector);
        await harness.run(["-B", String(raceId)]);

        // 馬番5 1 2 の順で確定: 提案(1-2-3-4)は外れ 基準(1-2-3-4-5)は的中する
        await crud.insertRaceInfo({
            id: raceId,
            raceName: "本日のS",
            date: TODAY,
            distance: 1600,
            trackSurface: "芝",
            raceNumber: 1,
            placeDetail: "東京",
        });
        await crud.insertRaceResults([
            resultRecord(raceId, 5, { horseId: 5001, orderOfFinish: 1 }),
            resultRecord(raceId, 1, { horseId: 5002, orderOfFinish: 2 }),
            resultRecord(raceId, 2, { horseId: 5003, orderOfFinish: 3 }),
        ]);
        await crud.insertPayoffs([{ raceId, ticketType: 8, horseNumbers: "5->1->2", payoff: 12340, popularity: 30 }]);

        const reporting = harnessWith(fakeClient([]), selector);
        await reporting.run(["--report", "--date", TODAY]);

        const report = reporting.outputs.join("\n");
        expect(report).toContain("3連単Boxの提案 1レース");
        expect(report).toContain("提案(AI) 1-2-3-4 4頭 24点 2,400円");
        expect(report).toContain("→ 外れ");
        expect(report).toContain("基準 1-2-3-4-5 5頭 60点 6,000円");
        expect(report).toContain("→ 的中 払戻12,340円");
        expect(report).toContain("提案: 的中0/1 購入2,400円 払戻0円 回収率0%");
        expect(report).toContain("基準: 的中1/1 購入6,000円 払戻12,340円 回収率206%");
    });

    test("--report prints nothing extra for a date without proposals", async () => {
        const harness = harnessWith(fakeClient([]), scriptedSelector([]).selector);
        await harness.run(["--report", "--date", "2026-01-31"]);
        expect(harness.outputs).toEqual(["2026-01-31 の保存済みの予測はありません (-P で予測してください)\n"]);
    });
});
