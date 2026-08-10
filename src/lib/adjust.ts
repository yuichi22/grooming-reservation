// 個別加算（犬ごとの時間調整）の共通ルール。管理画面・LIFF・Functions で同じ計算になるよう
// ここに集約する（functions/src/index.ts にも同じ規則の実装がある。片方だけ直さないこと）。
//
// 加算は ± 両方向。標準より早く仕上がる子はマイナスで登録する。
//
// ⚠ 3つの「時間」を必ず区別すること。混ぜるとお客様への案内か予約枠のどちらかが壊れる。
//   1. 標準時間       料金表(犬種×サービス)の値。
//   2. お客様表示時間  標準時間 + max(加算, 0)。
//                     短縮は伝えない。早く仕上がると約束するとお迎えの都合を縛るうえ、
//                     その日たまたま時間がかかったときにクレームになるため。
//                     逆に「延長」は伝える必要がある（お迎えが遅くなるので）。
//   3. 確定時間       標準時間 + 加算。予約枠の占有、カルテ／予約モーダルの管理値はこちら。
//                     短縮ぶんだけ枠が空くので、その日にもう1頭入れられる。
//
// ⚠ 料金は加算方向のみ反映する。短縮しても値引きしない（メニュー料金が下限）。
//   早く仕上がるのは店の技量や犬の性格であって、提供内容が減るわけではないため。

export const ceil50 = (n: number) => Math.ceil(n / 50) * 50;

/** 料金に反映する加算分。短縮(マイナス)は 0 として扱う。 */
export const chargeableAdj = (adj: number) => Math.max(0, adj);

/** 確定時間（予約枠の占有・管理画面の表示）。マイナスが標準を超えても 0 未満にはしない。 */
export const actualMin = (stdMin: number, adj: number) => Math.max(0, stdMin + adj);

/** お客様に伝える時間。短縮ぶんは伏せ、延長ぶんだけ足す。 */
export const customerMin = (stdMin: number, adj: number) => stdMin + chargeableAdj(adj);

/** 個別加算を反映した料金。単価(料金÷標準時間)×加算分を50円切上げで上乗せ。 */
export const adjustedPrice = (stdPrice: number, stdMin: number, adj: number) =>
  stdPrice + ceil50((stdMin > 0 ? stdPrice / stdMin : 0) * chargeableAdj(adj));

/** 入力できる加算の下限。標準時間を食い切らないよう -標準時間 で止める。 */
export const minAdj = (stdMin: number) => -stdMin;
