// TypeScript の標準ライブラリに JSON.rawJSON がまだ無いため 型だけを補う(Bunは実装済み)
interface JSON {
    /** JSON.stringify がそのまま出力する生のJSON値を作る 2^53を超える整数の桁を保つために使う */
    rawJSON(text: string): object;
}
