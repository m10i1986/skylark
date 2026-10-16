//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { afterEach, describe, expect, test } from "bun:test";

import { fetchEucJpHtml, HttpStatusError, readResponseText, requestWithTimeout } from "../src/scraper/http.ts";
import { mockFetch } from "./mock-fetch.ts";

// 「日本語」のEUC-JP表現
const EUC_JP_NIHONGO = new Uint8Array([0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec]);

let restore: (() => void) | undefined;

afterEach(() => {
    restore?.();
    restore = undefined;
});

describe("readResponseText", () => {
    test("decodes by the charset in Content-Type", async () => {
        const response = new Response(EUC_JP_NIHONGO, { headers: { "content-type": "text/html; charset=EUC-JP" } });
        expect(await readResponseText(response)).toBe("日本語");
    });

    test("defaults to UTF-8 without a charset", async () => {
        const response = new Response("日本語", { headers: { "content-type": "text/html" } });
        expect(await readResponseText(response)).toBe("日本語");
    });

    test("falls back to UTF-8 for an unknown charset", async () => {
        const response = new Response("abc", { headers: { "content-type": "text/html; charset=no-such-charset" } });
        expect(await readResponseText(response)).toBe("abc");
    });

    test("handles quoted charset values", async () => {
        const response = new Response(EUC_JP_NIHONGO, { headers: { "content-type": 'text/html; charset="euc-jp"' } });
        expect(await readResponseText(response)).toBe("日本語");
    });
});

describe("requestWithTimeout", () => {
    test("does not follow redirects, sends a user agent and applies a timeout signal", async () => {
        const mock = mockFetch(() => new Response("", { status: 200 }));
        restore = mock.restore;
        await requestWithTimeout("https://example.invalid/x", 5, { headers: { "X-Test": "1" } });
        const init = mock.calls[0]?.init;
        expect(init?.redirect).toBe("manual");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        const headers = new Headers(init?.headers);
        expect(headers.get("user-agent")).toMatch(/^skylark\//);
        expect(headers.get("x-test")).toBe("1");
    });
});

describe("fetchEucJpHtml", () => {
    test("decodes the body as EUC-JP regardless of headers", async () => {
        const mock = mockFetch(() => new Response(EUC_JP_NIHONGO, { status: 200 }));
        restore = mock.restore;
        expect(await fetchEucJpHtml("https://example.invalid/a", 5)).toBe("日本語");
    });

    test("replaces invalid bytes instead of failing", async () => {
        const mock = mockFetch(() => new Response(new Uint8Array([0x61, 0xff, 0x62]), { status: 200 }));
        restore = mock.restore;
        const html = await fetchEucJpHtml("https://example.invalid/a", 5);
        expect(html.startsWith("a")).toBe(true);
        expect(html.endsWith("b")).toBe(true);
    });

    test("throws HttpStatusError for non 2xx responses including redirects", async () => {
        const mock = mockFetch((url) =>
            url.endsWith("/missing") ? new Response("", { status: 404 }) : new Response("", { status: 302 }),
        );
        restore = mock.restore;
        const missing = fetchEucJpHtml("https://example.invalid/missing", 5);
        await expect(missing).rejects.toBeInstanceOf(HttpStatusError);
        await expect(missing).rejects.toMatchObject({ status: 404 });
        await expect(fetchEucJpHtml("https://example.invalid/moved", 5)).rejects.toMatchObject({ status: 302 });
    });
});
