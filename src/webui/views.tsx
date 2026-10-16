//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import type { FC } from "hono/jsx";

import type { HorseEntry, RaceDate, RaceInfoDraft, RaceListItem } from "./netkeiba-client.ts";

// JSXは文字列を自動でエスケープするため サイト由来の値をそのまま埋め込んでも注入されない
const STYLE = `
body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 1100px; padding: 0 1rem; color: #222; }
h1 { font-size: 1.6rem; } h2 { font-size: 1.2rem; margin-top: 2rem; }
label { display: block; margin: 0.8rem 0 0.2rem; font-weight: 600; }
select { min-width: 22rem; max-width: 100%; padding: 0.3rem; }
table { border-collapse: collapse; margin: 0.8rem 0; }
th, td { border: 1px solid #ccc; padding: 0.3rem 0.6rem; text-align: left; }
th { background: #f4f4f4; white-space: nowrap; }
.race-name { font-size: 2em; font-weight: 700; margin: 1rem 0 0.5rem; }
.notice { padding: 0.6rem 0.8rem; border-radius: 4px; margin: 1rem 0; }
.notice.info { background: #e8f1ff; } .notice.error { background: #ffe8e8; } .notice.ok { background: #e6f6e6; }
button { padding: 0.4rem 1rem; }
.scroll { overflow-x: auto; }
`;

export const Layout: FC = ({ children }) => (
    <html lang="ja">
        <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>Skylark</title>
            <style>{STYLE}</style>
        </head>
        <body>
            <h1>Skylark: netkeiba.com レース情報</h1>
            {children}
        </body>
    </html>
);

/** 画面に出す通知 */
export type Notice = { kind: "info" | "error" | "ok"; text: string };

export const NoticeBox: FC<{ notice: Notice }> = ({ notice }) => (
    <div class={`notice ${notice.kind}`}>{notice.text}</div>
);

type SelectProps = {
    name: string;
    label: string;
    options: string[];
    selected: number;
};

const Select: FC<SelectProps> = ({ name, label, options, selected }) => (
    <>
        <label for={name}>{label}</label>
        <select id={name} name={name}>
            {options.map((text, index) => (
                <option value={String(index)} selected={index === selected}>
                    {text}
                </option>
            ))}
        </select>
    </>
);

/** 画面に出すレース情報の表の行(表示名と値) */
export function buildRaceInfoRows(
    race: RaceInfoDraft,
    kaisaiDate: string | null,
): Array<[label: string, value: string]> {
    const text = (value: string | number | null | undefined): string => (value == null ? "" : String(value));
    return [
        ["ID", text(race.id)],
        ["開催日", text(kaisaiDate)],
        ["レース名", text(race.raceName)],
        ["距離", text(race.distance)],
        ["天候", text(race.weather)],
        ["発走時刻", text(race.postTime)],
        ["レース番号", text(race.raceNumber)],
        ["馬場", text(race.trackSurface)],
        ["馬場状態", text(race.trackCondition)],
        ["レースグレード", text(race.raceGrade)],
        ["レースクラス", text(race.raceClass)],
    ];
}

const HORSE_COLUMNS: Array<[label: string, value: (horse: HorseEntry) => string | number | null]> = [
    ["馬ID", (h) => h.horseId],
    ["馬番", (h) => h.horseNumber],
    ["枠番", (h) => h.wakuNumber],
    ["馬名", (h) => h.horseName],
    ["馬齢", (h) => h.barei],
    ["斤量", (h) => h.basisWeight],
    ["騎手ID", (h) => h.jockeyId],
    ["騎手名", (h) => h.jockeyName],
    ["調教師ID", (h) => h.trainerId],
    ["調教師名", (h) => h.trainerName],
    ["オッズ", (h) => h.odds],
    ["人気", (h) => h.popularity],
    ["馬体重", (h) => h.horseWeight],
    ["馬体重増減", (h) => h.horseWeightDiff],
];

/** 詳細表示に必要な情報 */
export type RaceDetail = {
    raceId: number;
    race: RaceInfoDraft;
    horses: HorseEntry[];
    kaisaiDate: string | null;
    // 保存済みか
    isSaved: boolean;
    // 保存できない理由 保存できる場合はnull
    unsavableReason: string | null;
};

export type PageProps = {
    dates: RaceDate[];
    dateIndex: number;
    races: RaceListItem[] | null;
    raceIndex: number;
    selectedRaceText: string | null;
    detail: RaceDetail | null;
    notice: Notice | null;
};

export const IndexPage: FC<PageProps> = (props) => {
    const { dates, dateIndex, races, raceIndex, selectedRaceText, detail, notice } = props;
    const selectedDate = dates[dateIndex];

    return (
        <Layout>
            {notice != null && <NoticeBox notice={notice} />}
            <h2>開催日を選択</h2>
            <form method="get" action="/">
                <Select name="date" label="開催日" options={dates.map((date) => date.text)} selected={dateIndex} />
                {races != null && races.length > 0 && (
                    <Select name="race" label="レース" options={races.map((race) => race.text)} selected={raceIndex} />
                )}
                <p>
                    <button type="submit">表示</button>
                </p>
            </form>

            {selectedDate != null && <h2>{`${selectedDate.kaisaiDate ?? selectedDate.text} のレース一覧`}</h2>}
            {races != null && races.length === 0 && (
                <NoticeBox notice={{ kind: "info", text: "レースが見つかりませんでした。" }} />
            )}

            {detail != null && (
                <>
                    <h2>{`レース情報: ${selectedRaceText ?? ""}`}</h2>
                    <div class="race-name">{detail.race.raceName ?? ""}</div>
                    <table>
                        <tbody>
                            {buildRaceInfoRows(detail.race, detail.kaisaiDate).map(([label, value]) => (
                                <tr>
                                    <th>{label}</th>
                                    <td>{value}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    <h2>出走馬情報</h2>
                    <div class="scroll">
                        <table>
                            <thead>
                                <tr>
                                    {HORSE_COLUMNS.map(([label]) => (
                                        <th>{label}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {detail.horses.map((horse) => (
                                    <tr>
                                        {HORSE_COLUMNS.map(([, value]) => (
                                            <td>{value(horse) ?? ""}</td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <form method="post" action="/save">
                        <input type="hidden" name="date" value={String(dateIndex)} />
                        <input type="hidden" name="race" value={String(raceIndex)} />
                        <input type="hidden" name="raceId" value={String(detail.raceId)} />
                        <button type="submit" disabled={detail.isSaved || detail.unsavableReason != null}>
                            レース情報をDB保管
                        </button>
                        {detail.isSaved && <span> 保管済みです</span>}
                        {detail.unsavableReason != null && <span>{` ${detail.unsavableReason}`}</span>}
                    </form>
                </>
            )}
        </Layout>
    );
};
