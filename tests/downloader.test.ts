//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sleep } from "../src/concurrency.ts";
import type { RaceInfoRecord } from "../src/db/schema.ts";
import { downloadRaces, login } from "../src/scraper/downloader.ts";
import { HttpStatusError } from "../src/scraper/http.ts";
import type { RaceSink } from "../src/scraper/race-scraper.ts";
import { createRecordingLogger, mockFetch } from "./mock-fetch.ts";
import { buildRacePageHtml } from "./race-page-fixture.ts";

// Python の zstandard で "<html><body>互換テスト ABC</body></html>" を圧縮したデータ
const PYTHON_ZSTD_BASE64 = "KLUv/SAtaQEAPGh0bWw+PGJvZHk+5LqS5o+b44OG44K544OIIEFCQzwvYm9keT48L2h0bWw+";
const PYTHON_ZSTD_TEXT = "<html><body>互換テスト ABC</body></html>";

type RecordingSink = RaceSink & { raceInfos: RaceInfoRecord[]; resultCounts: number[] };

function createSink(): RecordingSink {
    const raceInfos: RaceInfoRecord[] = [];
    const resultCounts: number[] = [];
    return {
        raceInfos,
        resultCounts,
        insertRaceInfo: async (record) => {
            raceInfos.push(record);
        },
        insertHorses: async () => {},
        insertJockeys: async () => {},
        insertTrainers: async () => {},
        insertOwners: async () => {},
        insertRaceResults: async (records) => {
            resultCounts.push(records.length);
        },
        insertPayoffs: async () => {},
    };
}

let tempDir: string;

beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "skylark-dl-"));
});

afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
});

const baseOptions = () => ({ tempDir, politeDelayMilliseconds: 0, timeoutSeconds: 5, maxConcurrentRequests: 4 });

describe("zstd cache compatibility", () => {
    test("Bun decompresses data produced by Python's zstandard", async () => {
        const compressed = Uint8Array.from(Buffer.from(PYTHON_ZSTD_BASE64, "base64"));
        const text = new TextDecoder().decode(await Bun.zstdDecompress(compressed));
        expect(text).toBe(PYTHON_ZSTD_TEXT);
    });
});

describe("downloadRaces", () => {
    test("downloads, caches as zstd and scrapes a race", async () => {
        const sink = createSink();
        const fetched: string[] = [];
        await downloadRaces(["/race/209901010101/"], {
            ...baseOptions(),
            sink,
            logger: createRecordingLogger(),
            fetchHtml: async (url) => {
                fetched.push(url);
                return buildRacePageHtml();
            },
        });

        expect(fetched).toEqual(["https://db.netkeiba.com/race/209901010101/"]);
        expect(sink.raceInfos[0]?.id).toBe(209901010101);
        expect(sink.resultCounts).toEqual([3]);

        const cacheFile = path.join(tempDir, "race.209901010101.html.zst");
        const cached = new TextDecoder().decode(await Bun.zstdDecompress(await Bun.file(cacheFile).bytes()));
        expect(cached).toBe(buildRacePageHtml());
        expect((await readdir(tempDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    test("uses the cache without any request the second time", async () => {
        const options = { ...baseOptions(), logger: createRecordingLogger() };
        await downloadRaces(["/race/209901010101/"], {
            ...options,
            sink: createSink(),
            fetchHtml: async () => buildRacePageHtml(),
        });

        const sink = createSink();
        await downloadRaces(["/race/209901010101/"], {
            ...options,
            sink,
            fetchHtml: async () => {
                throw new Error("must not fetch");
            },
        });
        expect(sink.resultCounts).toEqual([3]);
    });

    test("reads a cache file in the documented format (UTF-8 text compressed with zstd)", async () => {
        const html = buildRacePageHtml();
        await Bun.write(path.join(tempDir, "race.209901010101.html.zst"), await Bun.zstdCompress(html));
        const sink = createSink();
        await downloadRaces(["/race/209901010101/"], {
            ...baseOptions(),
            sink,
            logger: createRecordingLogger(),
            fetchHtml: async () => {
                throw new Error("must not fetch");
            },
        });
        expect(sink.raceInfos).toHaveLength(1);
    });

    test("skips ignored race ids without requesting them", async () => {
        const logger = createRecordingLogger();
        const fetched: string[] = [];
        await downloadRaces(["/race/200808020398/", "/race/202209040704/"], {
            ...baseOptions(),
            sink: createSink(),
            logger,
            fetchHtml: async (url) => {
                fetched.push(url);
                return "";
            },
        });
        expect(fetched).toEqual([]);
        expect(logger.ofLevel("warning")).toHaveLength(2);
        expect(logger.ofLevel("warning")[0]).toContain("reject[ignore_race_id]");
    });

    test("ignores paths that are not race result pages", async () => {
        const fetched: string[] = [];
        await downloadRaces(["/race/list/20250726/", "/horse/1/", "race_list.txt"], {
            ...baseOptions(),
            sink: createSink(),
            logger: createRecordingLogger(),
            fetchHtml: async (url) => {
                fetched.push(url);
                return "";
            },
        });
        expect(fetched).toEqual([]);
    });

    test("logs a failed download and keeps processing the other races", async () => {
        const logger = createRecordingLogger();
        const sink = createSink();
        await downloadRaces(["/race/209901010101/", "/race/209901010102/"], {
            ...baseOptions(),
            sink,
            logger,
            fetchHtml: async (url) => {
                if (url.endsWith("209901010101/")) {
                    throw new HttpStatusError(503, url);
                }
                return buildRacePageHtml();
            },
        });
        expect(logger.ofLevel("warning").join("\n")).toContain("HTTP 503");
        expect(sink.raceInfos.map((info) => info.id)).toEqual([209901010102]);
        expect(await Bun.file(path.join(tempDir, "race.209901010101.html.zst")).exists()).toBe(false);
    });

    test("isolates a corrupted cache file as an error without stopping others", async () => {
        const logger = createRecordingLogger();
        const sink = createSink();
        await Bun.write(path.join(tempDir, "race.209901010101.html.zst"), "not zstd data");
        await downloadRaces(["/race/209901010101/", "/race/209901010102/"], {
            ...baseOptions(),
            sink,
            logger,
            fetchHtml: async () => buildRacePageHtml(),
        });
        expect(logger.ofLevel("error")).toHaveLength(1);
        expect(logger.ofLevel("error")[0]).toContain("209901010101");
        expect(sink.raceInfos.map((info) => info.id)).toEqual([209901010102]);
    });

    test("never runs more downloads than the concurrency limit", async () => {
        let running = 0;
        let peak = 0;
        const paths = Array.from({ length: 12 }, (_, i) => `/race/20990101${String(i + 1).padStart(4, "0")}/`);
        await downloadRaces(paths, {
            ...baseOptions(),
            maxConcurrentRequests: 3,
            sink: createSink(),
            logger: createRecordingLogger(),
            fetchHtml: async () => {
                running++;
                peak = Math.max(peak, running);
                await sleep(5);
                running--;
                return buildRacePageHtml();
            },
        });
        expect(peak).toBe(3);
    });

    test("logs a parse failure of one page and continues", async () => {
        const logger = createRecordingLogger();
        const sink = createSink();
        await downloadRaces(["/race/209901010101/", "/race/209901010102/"], {
            ...baseOptions(),
            sink,
            logger,
            fetchHtml: async (url) => (url.endsWith("0101/") ? "<html></html>" : buildRacePageHtml()),
        });
        expect(logger.ofLevel("error")[0]).toContain("209901010101");
        expect(sink.raceInfos.map((info) => info.id)).toEqual([209901010102]);
    });
});

describe("login", () => {
    let restore: (() => void) | undefined;

    afterEach(() => {
        restore?.();
        restore = undefined;
    });

    test("is skipped without credentials and sends no request", async () => {
        const mock = mockFetch(() => new Response(""));
        restore = mock.restore;
        const logger = createRecordingLogger();
        expect(await login(null, 5, logger)).toBeNull();
        expect(await login({ loginId: "", password: "x" }, 5, logger)).toBeNull();
        expect(await login({ loginId: "x", password: "" }, 5, logger)).toBeNull();
        expect(mock.calls).toHaveLength(0);
    });

    test("posts the form and reports success", async () => {
        const mock = mockFetch(() => new Response("<html><body>ok</body></html>"));
        restore = mock.restore;
        const logger = createRecordingLogger();
        expect(await login({ loginId: "id", password: "p@ss word" }, 5, logger)).toBe(true);
        const call = mock.calls[0];
        expect(call?.url).toBe("https://account.netkeiba.com");
        expect(call?.init?.method).toBe("POST");
        const body = new URLSearchParams(String(call?.init?.body));
        expect(Object.fromEntries(body)).toEqual({ pid: "login", action: "auth", login_id: "id", pswd: "p@ss word" });
    });

    test("reports failure with the site's error message and never logs the password", async () => {
        const mock = mockFetch(
            () => new Response('<html><body><span class="error">IDまたはパスワードが違います</span></body></html>'),
        );
        restore = mock.restore;
        const logger = createRecordingLogger();
        expect(await login({ loginId: "id", password: "secret-password" }, 5, logger)).toBe(false);
        expect(logger.ofLevel("error")).toEqual(["IDまたはパスワードが違います"]);
        expect(JSON.stringify(logger.messages)).not.toContain("secret-password");
    });
});
