//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

import { CircleAlertIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { JobEntry, JobStatus, JobSummary, JobView } from "./job-runner.ts";
import {
    FLAG_ON,
    type FlagField,
    MAX_FIELD_CHARS,
    MAX_PERIOD_MONTHS,
    MAX_RACE_IDS,
    MAX_RACE_IDS_CHARS,
    MIN_PERIOD_MONTHS,
    type OperationDefaults,
    type OperationFormValues,
    type TextField,
} from "./operation-fields.ts";
import { TerminalText } from "./terminal-text.tsx";
import { BoxHorsesSelect, type Notice, NoticeBox, SiteNav } from "./views.tsx";

/** 操作画面の描画に必要な値 JSONにできる値だけを持つ */
export type OperationsPageProps = {
    // 入力済みの値(エラーで戻したときに入力を残す)
    values: OperationFormValues;
    errors: string[];
    notice: Notice | null;
    defaults: OperationDefaults;
    // 新しい順
    jobs: JobSummary[];
    runningJobId: string | null;
};

/** ジョブ画面の描画に必要な値 */
export type JobPageProps = { job: JobView };

/** ジョブの更新を取得する応答 */
export type JobEventsResponse = Pick<
    JobView,
    "status" | "finishedAt" | "entries" | "droppedLogLines" | "isOutputTruncated" | "lastSeq"
>;

const POLL_INTERVAL_MS = 1000;
// ブラウザに残すログの行数(サーバーの保持数と合わせる)
const MAX_CLIENT_LOG_LINES = 2000;
const CLI_COMMAND = "bun run src/cli.ts";

const STATUS_LABELS: Record<JobStatus, string> = { running: "実行中", succeeded: "成功", failed: "失敗" };
const STATUS_VARIANTS = { running: "default", succeeded: "secondary", failed: "destructive" } as const;

function StatusBadge({ status }: { status: JobStatus }): ReactNode {
    return <Badge variant={STATUS_VARIANTS[status]}>{STATUS_LABELS[status]}</Badge>;
}

type CheckboxFieldProps = {
    name: FlagField;
    label: string;
    description?: string;
    values: OperationFormValues;
};

// 送信にはチェックされたときだけ値が付く 入力を残すため初期状態を値から決める
function CheckboxField({ name, label, description, values }: CheckboxFieldProps): ReactNode {
    return (
        <label className="flex items-start gap-3 text-sm">
            <input
                type="checkbox"
                name={name}
                value={FLAG_ON}
                defaultChecked={values[name] === FLAG_ON}
                className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <span className="grid gap-1">
                <span className="font-medium">{label}</span>
                {description != null && <span className="text-muted-foreground">{description}</span>}
            </span>
        </label>
    );
}

type InputFieldProps = {
    name: TextField;
    label: string;
    hint?: string;
    placeholder?: string;
    values: OperationFormValues;
    inputMode?: "numeric" | "decimal" | "text";
};

function InputField({ name, label, hint, placeholder, values, inputMode = "text" }: InputFieldProps): ReactNode {
    const id = `field-${name}`;
    return (
        <div className="grid gap-2">
            <Label htmlFor={id}>{label}</Label>
            <Input
                id={id}
                name={name}
                defaultValue={values[name] ?? ""}
                placeholder={placeholder}
                inputMode={inputMode}
                maxLength={MAX_FIELD_CHARS}
                autoComplete="off"
            />
            {hint != null && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
    );
}

function JobList({ jobs }: { jobs: JobSummary[] }): ReactNode {
    return (
        <Card>
            <CardHeader>
                <CardTitle>最近のジョブ</CardTitle>
                <CardDescription>サーバーのメモリにだけ保持します。サーバーを再起動すると消えます。</CardDescription>
            </CardHeader>
            <CardContent>
                {jobs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">まだ実行していません。</p>
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>開始</TableHead>
                                <TableHead>処理</TableHead>
                                <TableHead>状態</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {jobs.map((job) => (
                                <TableRow key={job.id}>
                                    <TableCell className="whitespace-nowrap">{job.startedAt}</TableCell>
                                    <TableCell className="whitespace-normal">
                                        <a href={`/jobs/${job.id}`} className="underline underline-offset-4">
                                            {job.title}
                                        </a>
                                    </TableCell>
                                    <TableCell>
                                        <StatusBadge status={job.status} />
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </CardContent>
        </Card>
    );
}

/** CLIの全操作を実行するフォームの画面 */
export function OperationsPage(props: OperationsPageProps): ReactNode {
    const { values, errors, notice, defaults, jobs, runningJobId } = props;

    return (
        <main className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-8">
            <h1 className="text-2xl font-semibold tracking-tight">Skylark: 操作</h1>
            <SiteNav current="operations" isOperationsEnabled />

            {notice != null && <NoticeBox notice={notice} />}
            {errors.length > 0 && (
                <Alert variant="destructive" role="alert">
                    <CircleAlertIcon />
                    <AlertDescription className="text-current">
                        <ul className="list-disc pl-4">
                            {errors.map((error) => (
                                <li key={error}>{error}</li>
                            ))}
                        </ul>
                    </AlertDescription>
                </Alert>
            )}
            {runningJobId != null && (
                <NoticeBox
                    notice={{
                        kind: "info",
                        text: "実行中のジョブがあります。終わるまで新しいジョブは始められません。",
                    }}
                />
            )}
            {runningJobId != null && (
                <a href={`/jobs/${runningJobId}`} className="text-sm underline underline-offset-4">
                    実行中のジョブを見る
                </a>
            )}

            <form method="post" action="/operations" className="flex flex-col gap-6">
                <Card>
                    <CardHeader>
                        <CardTitle>実行する処理</CardTitle>
                        <CardDescription>
                            選んだ処理を、上から順に実行します(コマンドラインと同じ順です)。
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-4">
                        <CheckboxField
                            name="updateRaceList"
                            label="レース一覧の更新 (-U, --update-race-list)"
                            description="開催日のカレンダーから、取得するレースの一覧ファイルを作り直します。"
                            values={values}
                        />
                        <CheckboxField
                            name="scraping"
                            label="ダウンロードと保存 (-S, --scraping)"
                            description="レース結果を取得して DB へ保存します。レース ID を指定しない場合は、一覧ファイルのレースが対象です。"
                            values={values}
                        />
                        <CheckboxField
                            name="feature"
                            label="特徴量の計算 (-F, --feature)"
                            description="馬ごとの特徴量を計算して DB へ保存します。"
                            values={values}
                        />
                        <CheckboxField
                            name="train"
                            label="勝率モデルの学習 (-T, --train)"
                            description="過去の結果から勝率モデルを学習し、評価を表示して DB へ保存します。"
                            values={values}
                        />
                        <CheckboxField
                            name="predict"
                            label="当日の予測と抽出 (-P, --predict)"
                            description="当日開催の中央競馬を予測し、勝率が高いのに人気がない馬を抽出します。ブラウザ(Chromium)で出馬表を取得します。"
                            values={values}
                        />
                        <CheckboxField
                            name="aiBox"
                            label="3連単Boxの提案 (-B, --ai-box)"
                            description="指定したレースを予測し、AI(Claude)に3連単Boxで買う馬を選ばせます。レースごとに Claude CLI(claude)を呼び、Claude の利用枠を消費します(CLI のログインが必要)。レース ID の指定が必須で、1 回に 12 件までです。"
                            values={values}
                        />
                        <CheckboxField
                            name="report"
                            label="予測と確定結果の突き合わせ (--report)"
                            description="保存済みの予測とBoxの提案を、確定した結果と突き合わせます。"
                            values={values}
                        />
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>設定</CardTitle>
                        <CardDescription>空欄の項目は、コマンドラインの既定値を使います。</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-6">
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            <InputField
                                name="periodOfMonths"
                                label="一覧を遡る月数 (--period-of-months)"
                                hint={`-U で使います。${MIN_PERIOD_MONTHS} 〜 ${MAX_PERIOD_MONTHS}`}
                                placeholder={String(defaults.periodOfMonths)}
                                inputMode="numeric"
                                values={values}
                            />
                            <InputField
                                name="raceListFile"
                                label="レース一覧のファイル名 (--race-list-file)"
                                hint={`${defaults.tempDirectory} の下に置きます(置き場はサーバーで固定されています)。`}
                                placeholder={defaults.raceListFile}
                                values={values}
                            />
                            <InputField
                                name="date"
                                label="突き合わせの開催日 (--date)"
                                hint="--report で使います。YYYY-MM-DD。空欄は今日です。"
                                placeholder="2026-01-31"
                                values={values}
                            />
                            <InputField
                                name="historySince"
                                label="履歴の開始日 (--history-since)"
                                hint="-T と -P が履歴に使う最初の開催日です。"
                                placeholder={defaults.historySince}
                                values={values}
                            />
                        </div>

                        <div>
                            <h3 className="mb-3 text-sm font-medium">抽出条件 (-T と -P)</h3>
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                                <InputField
                                    name="minOdds"
                                    label="単勝オッズ (--min-odds)"
                                    hint="N 倍以上"
                                    placeholder={String(defaults.minOdds)}
                                    inputMode="decimal"
                                    values={values}
                                />
                                <InputField
                                    name="minPopularity"
                                    label="人気 (--min-popularity)"
                                    hint="N 位以下(大きいほど不人気)"
                                    placeholder={String(defaults.minPopularity)}
                                    inputMode="numeric"
                                    values={values}
                                />
                                <InputField
                                    name="maxRank"
                                    label="モデルの勝率順位 (--max-rank)"
                                    hint="N 位以内"
                                    placeholder={String(defaults.maxRank)}
                                    inputMode="numeric"
                                    values={values}
                                />
                                <InputField
                                    name="minEv"
                                    label="期待値 (--min-ev)"
                                    hint="N 以上。0 で条件にしません"
                                    placeholder={String(defaults.minExpectedValue)}
                                    inputMode="decimal"
                                    values={values}
                                />
                            </div>
                        </div>

                        <div>
                            <h3 className="mb-3 text-sm font-medium">3連単Box (-B)</h3>
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                                <div className="grid gap-2">
                                    <Label htmlFor="field-boxHorses">Box の頭数 (--box-horses)</Label>
                                    <BoxHorsesSelect
                                        id="field-boxHorses"
                                        selectedHorses={values.boxHorses == null ? null : Number(values.boxHorses)}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        頭数を選ぶと、その頭数ちょうどの Box にします(AI は入れる馬だけを選びます)。「AI
                                        におまかせ」は、点数の上限(--box-max-tickets、既定は 60 点)の範囲で AI
                                        が頭数も選びます。1点100円
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="grid gap-4">
                            <CheckboxField
                                name="verbose"
                                label="全レース・全出走馬を表示する (--verbose)"
                                description="-P の報告に、抽出した馬がいないレースも含めます。"
                                values={values}
                            />
                            <CheckboxField name="debug" label="デバッグログを出す (--debug)" values={values} />
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>レース ID</CardTitle>
                        <CardDescription>
                            -S は指定したレースだけをダウンロードし、-P は指定したレースだけを予測します。空欄の場合は、
                            -S は一覧ファイルのレース、-P は当日の全レースが対象です。-B
                            は、指定したレースだけが対象です。
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-2">
                        <Label htmlFor="field-raceIds">
                            レース ID(空白、改行、カンマ区切り。{MAX_RACE_IDS} 件まで)
                        </Label>
                        <Textarea
                            id="field-raceIds"
                            name="raceIds"
                            defaultValue={values.raceIds ?? ""}
                            placeholder="202501010101 202501010102"
                            maxLength={MAX_RACE_IDS_CHARS}
                            spellCheck={false}
                            autoComplete="off"
                        />
                    </CardContent>
                </Card>

                <Card className="ring-destructive/40">
                    <CardHeader>
                        <CardTitle>データを消す操作</CardTitle>
                        <CardDescription>
                            実行すると元に戻せません。内容を理解したうえで、確認欄にチェックしてください。
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-6">
                        <div className="grid gap-3">
                            <CheckboxField
                                name="rebuildFeature"
                                label="特徴量テーブルを空にして計算し直す (-Rf, --rebuild-feature)"
                                description="特徴量テーブルの全行を削除してから、特徴量を計算し直します。"
                                values={values}
                            />
                            <div className="pl-7">
                                <CheckboxField
                                    name="confirmRebuildFeature"
                                    label="特徴量テーブルの行が削除されることを理解しました"
                                    values={values}
                                />
                            </div>
                        </div>
                        <div className="grid gap-3">
                            <CheckboxField
                                name="rebuildAllTables"
                                label="全テーブルの行を削除する (--rebuild-all-tables)"
                                description="レース結果や特徴量など、すべてのテーブルの行を削除します。取得時のオッズを残した予測とBoxの提案、モデルは削除しません。"
                                values={values}
                            />
                            <div className="pl-7">
                                <CheckboxField
                                    name="confirmRebuildAllTables"
                                    label="全テーブルの行が削除されることを理解しました"
                                    values={values}
                                />
                            </div>
                        </div>
                    </CardContent>
                </Card>

                <div className="flex flex-wrap items-center gap-3">
                    <Button type="submit" disabled={runningJobId != null}>
                        実行
                    </Button>
                    <span className="text-sm text-muted-foreground">
                        HTML のキャッシュは {defaults.tempDirectory} に置きます。
                    </span>
                </div>
            </form>

            <JobList jobs={jobs} />
        </main>
    );
}

/**
 * 取得した更新を 画面のジョブの内容へ取り込む
 *
 * @param previous - 画面が持つジョブの内容
 * @param update - 取得した更新(前回の続きの出力と 最新の状態)
 * @returns 更新後の内容
 */
export function mergeJobEvents(previous: JobView, update: JobEventsResponse): JobView {
    const fresh = update.entries.filter((entry) => entry.seq > previous.lastSeq);
    let entries: JobEntry[] = [...previous.entries, ...fresh];
    const logCount = entries.filter((entry) => entry.kind === "log").length;
    const clientDroppedLines = Math.max(logCount - MAX_CLIENT_LOG_LINES, 0);
    if (clientDroppedLines > 0) {
        // 報告は残し 古いログから捨てる
        let excess = clientDroppedLines;
        entries = entries.filter((entry) => {
            if (entry.kind === "log" && excess > 0) {
                excess--;
                return false;
            }
            return true;
        });
    }
    return {
        ...previous,
        status: update.status,
        finishedAt: update.finishedAt,
        entries,
        droppedLogLines: previous.droppedLogLines + clientDroppedLines,
        isOutputTruncated: update.isOutputTruncated,
        lastSeq: Math.max(previous.lastSeq, update.lastSeq),
    };
}

function isJobEventsResponse(value: unknown): value is JobEventsResponse {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    // 形を確かめるための型ガードの中だけで 各項目を未検証のまま読む(確かめた項目だけを使う)
    const candidate = value as Partial<JobEventsResponse>;
    return (
        (candidate.status === "running" || candidate.status === "succeeded" || candidate.status === "failed") &&
        Array.isArray(candidate.entries) &&
        typeof candidate.lastSeq === "number"
    );
}

function joinEntries(entries: JobEntry[], kind: JobEntry["kind"]): string {
    return entries
        .filter((entry) => entry.kind === kind)
        .map((entry) => entry.text)
        .join(kind === "log" ? "\n" : "");
}

/** ジョブの進み具合を見る画面 実行中は一定間隔で更新を取得する */
export function JobPage({ job: initial }: JobPageProps): ReactNode {
    const [job, setJob] = useState(initial);
    const [isLost, setIsLost] = useState(false);
    const lastSeq = useRef(initial.lastSeq);
    const logRef = useRef<HTMLPreElement>(null);
    const jobId = initial.id;
    const isRunning = job.status === "running";

    useEffect(() => {
        if (!isRunning) {
            return;
        }
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;

        // 前の取得が終わってから次の取得を予約する(取得が遅くても重ならない)
        const poll = async (): Promise<void> => {
            let shouldContinue = true;
            try {
                const response = await fetch(`/jobs/${encodeURIComponent(jobId)}/events?after=${lastSeq.current}`, {
                    signal: controller.signal,
                    headers: { accept: "application/json" },
                });
                if (response.status === 404) {
                    // サーバーを再起動するとジョブは消える
                    setIsLost(true);
                    shouldContinue = false;
                } else if (response.ok) {
                    const body: unknown = await response.json();
                    if (isJobEventsResponse(body)) {
                        lastSeq.current = Math.max(lastSeq.current, body.lastSeq);
                        setJob((previous) => mergeJobEvents(previous, body));
                        shouldContinue = body.status === "running";
                    }
                }
            } catch {
                // 画面を離れた場合と 一時的な通信の失敗 後者は次の機会に再試行する
                shouldContinue = !controller.signal.aborted;
            }
            if (shouldContinue) {
                timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
            }
        };
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);

        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [isRunning, jobId]);

    const logText = joinEntries(job.entries, "log");
    const outputText = joinEntries(job.entries, "output");

    // 実行中は最新のログが見えるよう 末尾へ送る
    // biome-ignore lint/correctness/useExhaustiveDependencies: ログが増えたときに送る
    useEffect(() => {
        if (isRunning && logRef.current != null) {
            logRef.current.scrollTop = logRef.current.scrollHeight;
        }
    }, [isRunning, logText]);

    return (
        <main className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-8">
            <h1 className="text-2xl font-semibold tracking-tight">Skylark: ジョブ</h1>
            <SiteNav current="operations" isOperationsEnabled />

            {isLost && (
                <NoticeBox
                    notice={{
                        kind: "error",
                        text: "ジョブが見つかりません。サーバーが再起動された可能性があります。",
                    }}
                />
            )}

            <Card>
                <CardHeader>
                    <div className="flex flex-wrap items-center gap-3">
                        <CardTitle className="text-lg">{job.title}</CardTitle>
                        <StatusBadge status={job.status} />
                    </div>
                    <CardDescription>
                        開始 {job.startedAt}
                        {job.finishedAt != null && ` / 終了 ${job.finishedAt}`}
                    </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2">
                    <p className="text-xs text-muted-foreground">コマンドラインでは次と同じです。</p>
                    <code className="block overflow-x-auto rounded-lg bg-muted px-3 py-2 text-xs">
                        {`${CLI_COMMAND} ${job.commandLine}`}
                    </code>
                </CardContent>
            </Card>

            {(outputText !== "" || job.isOutputTruncated) && (
                <Card>
                    <CardHeader>
                        <CardTitle>報告</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-2">
                        <pre className="max-h-[32rem] overflow-auto rounded-lg bg-muted p-3 text-xs leading-relaxed">
                            <TerminalText text={outputText} />
                        </pre>
                        {job.isOutputTruncated && (
                            <p className="text-xs text-muted-foreground">長いため、途中までを表示しています。</p>
                        )}
                    </CardContent>
                </Card>
            )}

            <Card>
                <CardHeader>
                    <CardTitle>ログ</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2">
                    <pre
                        ref={logRef}
                        className="max-h-96 min-h-16 overflow-auto rounded-lg bg-muted p-3 text-xs leading-relaxed"
                    >
                        {logText}
                    </pre>
                    {job.droppedLogLines > 0 && (
                        <p className="text-xs text-muted-foreground">
                            古いログ {job.droppedLogLines} 行は省略しました。
                        </p>
                    )}
                </CardContent>
            </Card>

            <a href="/operations" className="text-sm underline underline-offset-4">
                操作の画面へ戻る
            </a>
        </main>
    );
}
