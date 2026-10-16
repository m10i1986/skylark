//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { describe, expect, test } from "bun:test";

import { uniqueSortedByKey } from "../src/db/ordering.ts";

type Row = { id: string; name: string };

describe("uniqueSortedByKey", () => {
    test("sorts by key so that every writer locks rows in the same order", () => {
        const left: Row[] = [
            { id: "b", name: "1" },
            { id: "a", name: "2" },
            { id: "c", name: "3" },
        ];
        const right: Row[] = [...left].reverse();
        const sortedLeft = uniqueSortedByKey(left, (row) => [row.id]);
        const sortedRight = uniqueSortedByKey(right, (row) => [row.id]);
        expect(sortedLeft.map((row) => row.id)).toEqual(["a", "b", "c"]);
        expect(sortedRight.map((row) => row.id)).toEqual(["a", "b", "c"]);
    });

    test("keeps the first duplicate by default like the original get-then-add", () => {
        const rows: Row[] = [
            { id: "a", name: "first" },
            { id: "a", name: "second" },
        ];
        expect(uniqueSortedByKey(rows, (row) => [row.id])).toEqual([{ id: "a", name: "first" }]);
    });

    test("keeps the last duplicate when asked like merge", () => {
        const rows: Row[] = [
            { id: "a", name: "first" },
            { id: "a", name: "second" },
        ];
        expect(uniqueSortedByKey(rows, (row) => [row.id], "last")).toEqual([{ id: "a", name: "second" }]);
    });

    test("compares numbers numerically and composite keys part by part", () => {
        const rows = [
            { race: 10, no: 2 },
            { race: 9, no: 3 },
            { race: 10, no: 1 },
        ];
        const sorted = uniqueSortedByKey(rows, (row) => [row.race, row.no]);
        expect(sorted).toEqual([
            { race: 9, no: 3 },
            { race: 10, no: 1 },
            { race: 10, no: 2 },
        ]);
    });

    test("does not mutate the input and handles an empty list", () => {
        const rows: Row[] = [
            { id: "b", name: "1" },
            { id: "a", name: "2" },
        ];
        uniqueSortedByKey(rows, (row) => [row.id]);
        expect(rows.map((row) => row.id)).toEqual(["b", "a"]);
        expect(uniqueSortedByKey([], (row: Row) => [row.id])).toEqual([]);
    });
});
