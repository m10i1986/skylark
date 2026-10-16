//
// Copyright (c) MINETA "m10i" Hiroki <h-mineta@0nyx.net>
// This software is released under the MIT License.
//

// netkeiba のレース結果ページの構造を模した テスト用のHTMLを作る
// 馬名や識別子はすべて架空 独自タグ(diary_snap, diary_snap_cut)も実ページと同様に挟む

/** 出走馬1頭分の入力 */
export type FixtureRow = {
    order: string;
    bracket: string;
    horseNumber: string;
    horseId: string;
    horseName: string;
    sexAge: string;
    weight: string;
    jockeyId: string;
    jockeyName: string;
    time: string;
    margin: string;
    passing: string;
    lastPhase: string;
    odds: string;
    popularity: string;
    horseWeight: string;
    remark: string;
    // 「[東]」のような所属の表記
    stable: string;
    trainerId: string;
    trainerName: string;
    ownerId: string;
    ownerName: string;
    earning: string;
};

/** 払戻表の1行分の入力 */
export type FixturePayoffRow = {
    label: string;
    // セル内の複数行は <br /> で区切る
    horseNumbers: string;
    payoff: string;
    popularity: string;
};

export const WINNER_ROW: FixtureRow = {
    order: "1",
    bracket: "3",
    horseNumber: "3",
    horseId: "2099100001",
    horseName: "テストホースA",
    sexAge: "牝2",
    weight: "55",
    jockeyId: "01001",
    jockeyName: "騎手テスト",
    time: "1:08.9",
    margin: "",
    passing: "6-5",
    lastPhase: "34.1",
    odds: "4.8",
    popularity: "3",
    horseWeight: "408(+4)",
    remark: "",
    stable: "[東]",
    trainerId: "01002",
    trainerName: "調教師テスト",
    ownerId: "331002",
    ownerName: "馬主テスト",
    earning: "1,560.0",
};

export const SECOND_ROW: FixtureRow = {
    ...WINNER_ROW,
    order: "2",
    bracket: "4",
    horseNumber: "4",
    horseId: "2099100002",
    horseName: "テストホースB",
    sexAge: "牡2",
    jockeyId: "00002",
    jockeyName: "騎手テストB",
    time: "1:09.1",
    margin: "1.1/4",
    passing: "1-1",
    lastPhase: "34.9",
    odds: "1.5",
    popularity: "1",
    horseWeight: "466(-2)",
    remark: "出遅れ",
    stable: "[西]",
    trainerId: "05003",
    trainerName: "調教師テストB",
    ownerId: "000123",
    ownerName: "馬主テストB",
    earning: "560.0",
};

// 競走除外の馬 タイムやオッズなどが空になる
export const EXCLUDED_ROW: FixtureRow = {
    ...WINNER_ROW,
    order: "除",
    bracket: "5",
    horseNumber: "5",
    horseId: "2099100003",
    horseName: "テストホースC",
    sexAge: "セ3",
    time: "",
    margin: "",
    passing: "",
    lastPhase: "",
    odds: "---",
    popularity: "",
    horseWeight: "",
    remark: "",
    earning: "",
};

export const DEFAULT_PAYOFF_ROWS: FixturePayoffRow[] = [
    { label: "単勝", horseNumbers: "3", payoff: "480", popularity: "3" },
    {
        label: "複勝",
        horseNumbers: "3<br />4<br />2",
        payoff: "130<br />110<br />1,140",
        popularity: "2<br />1<br />3",
    },
    { label: "枠連", horseNumbers: "3 - 4", payoff: "590", popularity: "2" },
    {
        label: "ワイド",
        horseNumbers: "3 - 4<br />2 - 3<br />2 - 4",
        payoff: "240<br />360<br />260",
        popularity: "1<br />5<br />2",
    },
    { label: "馬単", horseNumbers: "3 → 4", payoff: "1,500", popularity: "5" },
    { label: "三連単", horseNumbers: "3 → 4 → 2", payoff: "4,960", popularity: "8" },
];

function buildResultRow(row: FixtureRow): string {
    return `<tr>
<td class="txt_r" nowrap="nowrap">${row.order}</td>
<td class="w3ml" align="right" nowrap="nowrap"><span>${row.bracket}</span></td>
<td class="txt_r" nowrap="nowrap">${row.horseNumber}</td>
<td class="txt_l" nowrap="nowrap">
<a href="/horse/${row.horseId}/" title="${row.horseName}" id="umalink_1">${row.horseName}</a>

</td>
<td class="txt_c" nowrap="nowrap">${row.sexAge}</td>
<td class="txt_c" nowrap="nowrap">${row.weight}</td>
<td class="txt_l" nowrap="nowrap">
<a href="/jockey/result/recent/${row.jockeyId}/" title="${row.jockeyName}">${row.jockeyName}</a>

</td>
<td class="txt_r" nowrap="nowrap">${row.time}</td>
<td class="txt_c" nowrap="nowrap">${row.margin}</td>

<diary_snap_cut>
<td class="speed_index bml " nowrap="nowrap">
<div class="txt_c">
<a href="https://example.invalid/premium/">**</a>
</div>

</td>
<td nowrap="nowrap">${row.passing}</td>
<td class="r1ml  txt_c" nowrap="nowrap"><span>${row.lastPhase}</span></td>
</diary_snap_cut>
<td class="txt_r" nowrap="nowrap">${row.odds}</td>
<td class="r3ml" align="right" nowrap="nowrap"><span>${row.popularity}</span></td>
<td nowrap="nowrap">${row.horseWeight}</td>
<diary_snap_cut>
<td class="txt_c " nowrap="nowrap"><a href="/?pid=horse_training"><img src="/x.gif" /></a></td>
<td class="txt_c " nowrap="nowrap"><a href="/?pid=horse_comment"><img src="/x.gif" /></a></td>
<td nowrap="nowrap">${row.remark}</td>
</diary_snap_cut>
<td class="txt_l" nowrap="nowrap">
${row.stable}
<a href="/trainer/result/recent/${row.trainerId}/" title="${row.trainerName}">${row.trainerName}</a>

</td>
<diary_snap_cut>
<td class="txt_l w3ml" nowrap="nowrap">
<a href="/owner/result/recent/${row.ownerId}/" title="${row.ownerName}">${row.ownerName}</a>

</td>
<td class="txt_r" nowrap="nowrap">${row.earning}</td>
</diary_snap_cut>
</tr>`;
}

function buildPayoffRow(row: FixturePayoffRow): string {
    return `<tr>
<th class="x">${row.label}</th>
<td>${row.horseNumbers}</td>
<td class="txt_r">${row.payoff}</td>
<td class="txt_r">${row.popularity}</td>
</tr>`;
}

/** ページ生成の入力 省略した項目は標準の内容になる */
export type RacePageOptions = {
    rows?: FixtureRow[];
    payoffRows?: FixturePayoffRow[];
    // レース番号の見出し「1 R」
    raceNumberText?: string;
    // 路面や距離などを含む行(span内の文字列)
    raceDataLines?: string;
    // 「2025年07月06日 1回札幌1日目 2歳未勝利」のような行
    dateLine?: string;
};

/**
 * レース結果ページ相当のHTMLを作る
 *
 * @param options - 内容の指定
 * @returns HTML
 */
export function buildRacePageHtml(options: RacePageOptions = {}): string {
    const rows = options.rows ?? [WINNER_ROW, SECOND_ROW, EXCLUDED_ROW];
    const payoffRows = options.payoffRows ?? DEFAULT_PAYOFF_ROWS;
    const raceNumberText = options.raceNumberText ?? "1 R";
    const raceDataLines =
        options.raceDataLines ??
        "芝右1200m&nbsp;/&nbsp;\n天候 : 曇&nbsp;/&nbsp;\n芝 : 良&nbsp;&nbsp;/&nbsp;\n発走 : 09:55";
    const dateLine = options.dateLine ?? "2025年07月06日 1回札幌1日目 2歳未勝利&nbsp;&nbsp;(混)[指](馬齢)";

    return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="ja" xml:lang="ja" id="html">
<head><title>テスト</title></head>
<body class="db" id="db_race_detail">
<div id="page" class="Wrap fc">
<div id="contents" class="db_contents">
<div id="main">
<div class="race_head">
<div class="race_head_inner">
<diary_snap>
<div class="mainrace_data fc">
<div class="data_intro">
<dl class="racedata fc">
<dt>
${raceNumberText}
</dt>
<dd>
<h1>テスト未勝利<!--img src="x.png" alt=""--></h1>
<p>
<diary_snap_cut>
<span>
${raceDataLines}
</span><br />
</diary_snap_cut>
</p>
</dd>
</dl>
<p class="smalltxt">${dateLine}</p>
</div>
</div>
</diary_snap>
</div>
</div>
</div>
<div id="contents_liquid">
<table class="race_table_01 nk_tb_common" summary="レース結果" cellspacing="1" cellpadding="0">
<tr class="txt_c">
<th nowrap="nowrap">着<br />順</th>
<th nowrap="nowrap">枠<br />番</th>
</tr>
${rows.map(buildResultRow).join("\n")}
</table>
</div>
<div class="result_info box_left">
<diary_snap>
<dl class="pay_block">
<dt><h3>払い戻し</h3></dt>
<dd class="fc">
<table cellpadding="0" cellspacing="1" class="pay_table_01" summary="払い戻し">
${payoffRows.map(buildPayoffRow).join("\n")}
</table>
</dd>
</dl>
</diary_snap>
</div>
</div>
</div>
</body>
</html>
`;
}
