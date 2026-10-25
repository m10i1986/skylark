//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { CircleAlertIcon, CircleCheckIcon, InfoIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { HorseEntry, RaceDate, RaceInfoDraft, RaceListItem } from "./netkeiba-client.ts";
import { FLAG_ON } from "./operation-fields.ts";

// Reactは文字列を自動でエスケープするため サイト由来の値をそのまま埋め込んでも注入されない

/** 画面に出す通知 */
export type Notice = { kind: "info" | "error" | "ok"; text: string };

const NOTICE_ICONS: Record<Notice["kind"], ReactNode> = {
    info: <InfoIcon />,
    ok: <CircleCheckIcon />,
    error: <CircleAlertIcon />,
};

export function NoticeBox({ notice }: { notice: Notice }): ReactNode {
    return (
        <Alert
            variant={notice.kind === "error" ? "destructive" : "default"}
            role={notice.kind === "error" ? "alert" : "status"}
        >
            {NOTICE_ICONS[notice.kind]}
            <AlertDescription className="text-current">{notice.text}</AlertDescription>
        </Alert>
    );
}

/** 画面の切り替え 操作の画面が無効な場合は何も出さない */
export function SiteNav({
    current,
    isOperationsEnabled,
}: {
    current: "races" | "operations";
    isOperationsEnabled: boolean;
}): ReactNode {
    if (!isOperationsEnabled) {
        return null;
    }
    const items = [
        { key: "races", href: "/", label: "レース情報" },
        { key: "operations", href: "/operations", label: "操作" },
    ] as const;
    return (
        <nav aria-label="画面の切り替え" className="flex gap-4 text-sm">
            {items.map((item) => (
                <a
                    key={item.key}
                    href={item.href}
                    aria-current={item.key === current ? "page" : undefined}
                    className={
                        item.key === current
                            ? "font-semibold underline underline-offset-4"
                            : "text-muted-foreground underline-offset-4 hover:underline"
                    }
                >
                    {item.label}
                </a>
            ))}
        </nav>
    );
}

/**
 * 開催日とレースの番号から画面のパスを作る
 *
 * レースを省略すると 先頭のレースを表示する(開催日を変えたとき 前の開催日のレース番号を持ち越さない)
 */
export function selectionPath(dateIndex: number, raceIndex?: number): string {
    const params = new URLSearchParams({ date: String(dateIndex) });
    if (raceIndex != null) {
        params.set("race", String(raceIndex));
    }
    return `/?${params.toString()}`;
}

type SelectFieldProps = {
    name: string;
    label: string;
    options: string[];
    selected: number;
    // 選択が変わったときに呼ぶ(選んだ選択肢の番号)
    onSelect: (index: number) => void;
};

// 選択肢を並べた選択欄 フォームの送信にはRadixが隠しselectを出す
// 表示する文字は自前で決める(サーバー側の描画では選択肢の一覧が無く Radixが文字を出せないため)
function SelectField({ name, label, options, selected, onSelect }: SelectFieldProps): ReactNode {
    const id = useId();
    const [value, setValue] = useState(String(selected));
    const handleValueChange = (next: string): void => {
        setValue(next);
        onSelect(Number(next));
    };

    return (
        <div className="grid w-full gap-2 sm:w-80">
            <Label htmlFor={id}>{label}</Label>
            <Select name={name} value={value} onValueChange={handleValueChange}>
                <SelectTrigger id={id} className="w-full">
                    <SelectValue>{options[Number(value)] ?? ""}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                    {options.map((text, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: 選択肢は表示順の番号で識別する(同じ文言が並び得る)
                        <SelectItem key={index} value={String(index)}>
                            {text}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}

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
    // 予測できない理由 予測できる場合はnull
    unpredictableReason: string | null;
};

/** レース情報の画面の描画に必要な値 JSONにできる値だけを持つ(クライアントへそのまま渡す) */
export type IndexPageProps = {
    dates: RaceDate[];
    dateIndex: number;
    races: RaceListItem[] | null;
    raceIndex: number;
    selectedRaceText: string | null;
    detail: RaceDetail | null;
    notice: Notice | null;
    // 操作の画面(CLIの全操作)を使えるか
    isOperationsEnabled: boolean;
};

function RaceDetailView({ detail, heading }: { detail: RaceDetail; heading: string }): ReactNode {
    return (
        <>
            <Card>
                <CardHeader>
                    <p className="text-sm text-muted-foreground">{heading}</p>
                    <CardTitle className="text-2xl">{detail.race.raceName ?? ""}</CardTitle>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableBody>
                            {buildRaceInfoRows(detail.race, detail.kaisaiDate).map(([label, value]) => (
                                <TableRow key={label}>
                                    <TableHead scope="row" className="w-40">
                                        {label}
                                    </TableHead>
                                    <TableCell>{value}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>出走馬情報</CardTitle>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                {HORSE_COLUMNS.map(([label]) => (
                                    <TableHead key={label} className="whitespace-nowrap">
                                        {label}
                                    </TableHead>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {detail.horses.map((horse, index) => (
                                // biome-ignore lint/suspicious/noArrayIndexKey: 馬の識別子は欠けることがあり 表は並べ替えない
                                <TableRow key={index}>
                                    {HORSE_COLUMNS.map(([label, value]) => (
                                        <TableCell key={label}>{value(horse) ?? ""}</TableCell>
                                    ))}
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </>
    );
}

// 表示中のレースだけを予測する 操作の画面と同じ送信先へ「予測と抽出」とレースIDを渡し 他の設定は既定値にする
function PredictForm({ detail }: { detail: RaceDetail }): ReactNode {
    return (
        <form method="post" action="/operations" className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="predict" value={FLAG_ON} />
            <input type="hidden" name="raceIds" value={String(detail.raceId)} />
            <Button type="submit" disabled={detail.unpredictableReason != null}>
                このレースを予測
            </Button>
            {detail.unpredictableReason != null && (
                <span className="text-sm text-muted-foreground">{detail.unpredictableReason}</span>
            )}
        </form>
    );
}

export function IndexPage(props: IndexPageProps): ReactNode {
    const { dates, dateIndex, races, raceIndex, selectedRaceText, detail, notice, isOperationsEnabled } = props;
    const selectedDate = dates[dateIndex];

    return (
        <main className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-8">
            <h1 className="text-2xl font-semibold tracking-tight">Skylark: netkeiba.com レース情報</h1>
            <SiteNav current="races" isOperationsEnabled={isOperationsEnabled} />

            {notice != null && <NoticeBox notice={notice} />}

            <Card>
                <CardHeader>
                    <CardTitle>開催日を選択</CardTitle>
                </CardHeader>
                <CardContent>
                    <form method="get" action="/" className="flex flex-wrap items-end gap-4">
                        <SelectField
                            name="date"
                            label="開催日"
                            options={dates.map((date) => date.text)}
                            selected={dateIndex}
                            // 開催日を変えたら すぐにその日のレース一覧へ切り替える
                            onSelect={(index) => window.location.assign(selectionPath(index))}
                        />
                        {races != null && races.length > 0 && (
                            <SelectField
                                name="race"
                                label="レース"
                                options={races.map((race) => race.text)}
                                selected={raceIndex}
                                onSelect={(index) => window.location.assign(selectionPath(dateIndex, index))}
                            />
                        )}
                        <Button type="submit">表示</Button>
                    </form>
                </CardContent>
            </Card>

            {selectedDate != null && (
                <h2 className="text-lg font-semibold">{`${selectedDate.kaisaiDate ?? selectedDate.text} のレース一覧`}</h2>
            )}
            {races != null && races.length === 0 && (
                <NoticeBox notice={{ kind: "info", text: "レースが見つかりませんでした。" }} />
            )}

            {detail != null && (
                <>
                    <RaceDetailView detail={detail} heading={`レース情報: ${selectedRaceText ?? ""}`} />

                    <form method="post" action="/save" className="flex flex-wrap items-center gap-3">
                        <input type="hidden" name="date" value={String(dateIndex)} />
                        <input type="hidden" name="race" value={String(raceIndex)} />
                        <input type="hidden" name="raceId" value={String(detail.raceId)} />
                        <Button type="submit" disabled={detail.isSaved || detail.unsavableReason != null}>
                            レース情報をDB保管
                        </Button>
                        {detail.isSaved && <Badge variant="secondary">保管済みです</Badge>}
                        {detail.unsavableReason != null && (
                            <span className="text-sm text-muted-foreground">{detail.unsavableReason}</span>
                        )}
                    </form>

                    {isOperationsEnabled && <PredictForm detail={detail} />}
                </>
            )}
        </main>
    );
}
