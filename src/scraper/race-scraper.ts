//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import type {
    HorseRecord,
    JockeyRecord,
    OwnerRecord,
    PayoffRecord,
    RaceInfoRecord,
    RaceResultRecord,
    TrainerRecord,
} from "../db/schema.ts";
import { describeError, type Logger } from "../logger.ts";
import { loadRaceDocument, parsePayoffs, parseRaceInfo, parseRaceResults } from "./race-parser.ts";

/** 解析結果の書き込み先 DBリポジトリや検証用の記録装置が実装する */
export type RaceSink = {
    insertRaceInfo(record: RaceInfoRecord): Promise<void>;
    insertHorses(records: HorseRecord[]): Promise<void>;
    insertJockeys(records: JockeyRecord[]): Promise<void>;
    insertTrainers(records: TrainerRecord[]): Promise<void>;
    insertOwners(records: OwnerRecord[]): Promise<void>;
    insertRaceResults(records: RaceResultRecord[]): Promise<void>;
    insertPayoffs(records: PayoffRecord[]): Promise<void>;
};

/**
 * レース結果ページ1件を解析して書き込み先へ保存する
 *
 * 保存の順序は移植元と同じで レース情報 → 馬 騎手 調教師 馬主 → レース結果 → 払戻
 * 途中で失敗しても それまでに保存した内容は残す 失敗はログへ記録して呼び出し元へは伝播しない
 *
 * @param raceId - レースID
 * @param html - レース結果ページのHTML
 * @param sink - 書き込み先
 * @param logger - ロガー
 */
export async function scrapeRaceHtml(raceId: number, html: string, sink: RaceSink, logger: Logger): Promise<void> {
    try {
        const $ = loadRaceDocument(html);

        await sink.insertRaceInfo(parseRaceInfo(raceId, $));

        const resultSet = parseRaceResults(raceId, $);
        await sink.insertHorses(resultSet.horses);
        await sink.insertJockeys(resultSet.jockeys);
        await sink.insertTrainers(resultSet.trainers);
        await sink.insertOwners(resultSet.owners);
        await sink.insertRaceResults(resultSet.results);

        const payoffs = parsePayoffs(raceId, $, (label) => {
            logger.warning(`Unknown ticket type, skip: ${label}`);
        });
        await sink.insertPayoffs(payoffs);
    } catch (error) {
        logger.error(`race_id: ${raceId}, failed to scrape: ${describeError(error)}`);
    }
}
