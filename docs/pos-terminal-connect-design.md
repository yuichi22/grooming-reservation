# POS カード決済（Stripe Terminal × Connect）Core 設計

対象: AKUTO **Core**（本リポジトリ / Functions v2・`asia-northeast1`・ESM・default DB・callable=camelCase・custom claims 認可）。
POS 実装本体は別repo `~/mobile_order-app`（Firestore named DB `'main'`）で、Phase2 で Core の callable を呼ぶ。
方式は **サーバードリブン統合**（ネイティブ/Xcode 不要・ConnectionToken 不要）で確定済み。日本は S700 一択（WisePOS E 未提供）。

> 現状: Core には Stripe / space / contract / 売上コレクションが未実装。本書は新規追加分の設計。

---

## 0. 紐付けの核（4階層）

| 概念 | Core 実体 | Stripe 実体 | 関係 |
|---|---|---|---|
| 組織 (tenant) | `tenants/{tenantId}` | **Connected Account**（`acct_…`） | 1 tenant = 1 connected account |
| 拠点 (space) | `tenants/{tenantId}/spaces/{spaceId}` | **Terminal Location**（`tml_…`） | 1 space = 1 location |
| 端末 | `…/spaces/{spaceId}/readers/{readerId}` | **Reader**（`tmr_…`, S700） | reader は location(=space) 配下 |
| 会計1件 | `tenants/{tenantId}/posSales/{paymentIntentId}` | **PaymentIntent**（`pi_…`） | direct charge on connected acct |

**PaymentIntent は必ず** `{ stripeAccount: <tenant の acct_…> }` を付けて **connected account 上に direct charge** で作成し、
`application_fee_amount`（プラットフォーム手数料, JPY 整数）と `metadata { tenantId, spaceId, contractId, orderId }` を持たせる。
Location / Reader / process_payment_intent / capture / refund も**すべて同じ `{stripeAccount}` を付けて connected account 上で操作**する（direct-charge モデル）。

---

## 1. 紐付け表（Stripe オブジェクト → Core 保存先 → 作成 API）

| Stripe オブジェクト | Core 保存先フィールド | 作成/取得 API（`{stripeAccount}` 明記） |
|---|---|---|
| Connected Account `acct_…` | `tenants/{t}.billing.stripeAccountId` | `stripe.accounts.create({ type:'standard'\|'express', country:'JP' })`（プラットフォーム側・`{stripeAccount}` 不要）＋ `stripe.accountLinks.create` でオンボーディング |
| Terminal Location `tml_…` | `tenants/{t}/spaces/{s}.stripeTerminalLocationId` | `stripe.terminal.locations.create({ display_name, address }, { stripeAccount })` |
| Reader `tmr_…` (S700) | `…/spaces/{s}/readers/{readerId}`（doc）＋ 一覧を `space.readerIds[]` | `stripe.terminal.readers.create({ registration_code, location:'tml_…', label }, { stripeAccount })` |
| PaymentIntent `pi_…` | `tenants/{t}/posSales/{pi_…}`（売上レコード, §4） | `stripe.paymentIntents.create({ amount, currency:'jpy', capture_method:'manual', payment_method_types:['card_present'], application_fee_amount, metadata }, { stripeAccount, idempotencyKey })` |
| （端末への送出）reader.process | `posSales.readerAction` に action id/状態 | `stripe.terminal.readers.processPaymentIntent(readerId, { payment_intent:'pi_…' }, { stripeAccount })` |
| Capture | `posSales.status='captured'` | `stripe.paymentIntents.capture('pi_…', undefined, { stripeAccount })` |
| Refund `re_…` | `posSales.refunds[]`（{id,amount,reason,at}） | `stripe.refunds.create({ payment_intent:'pi_…', amount? }, { stripeAccount, idempotencyKey })` |
| Connect Webhook イベント | 各 `posSales` を更新（§3） | プラットフォームの **Connect webhook endpoint**（`event.account` で tenant 逆引き） |

> Account 自体はプラットフォーム所有なので `accounts.create` に `{stripeAccount}` は付けない。**それ以外の Terminal/PI/Refund は全部 `{stripeAccount}` 必須。**

---

## 2. Core callable（すべて custom claims 認可・`asia-northeast1`・v2 onCall）

呼び出しは 2 系統: (a) 管理系（Core 管理画面のスタッフ = custom claims `role:'admin'`/`superAdmin`）、(b) POS 実行系（mobile_order から。**App Check + tenant スコープ claim** を要求, §5注意）。

### 2-1. `createTerminalLocation`（管理系）
- 役割: space に対応する Terminal Location を connected account 上に作成し、`space.stripeTerminalLocationId` を保存。
- 引数: `{ tenantId, spaceId, displayName, address:{line1,city,postal_code,country:'JP',...} }`
- 前提: `tenant.billing.stripeAccountId` が存在し onboarding 済み。
- 戻り: `{ stripeTerminalLocationId }`。冪等: 既存 location があれば再利用。

### 2-2. `registerTerminalReader`（管理系）
- 役割: S700 の登録コード（端末画面に表示）で Reader を location に登録し `…/spaces/{s}/readers/{readerId}` を作成。
- 引数: `{ tenantId, spaceId, registrationCode, label }`
- 戻り: `{ readerId, status }`。以降 POS は `readerId` を指定して決済する。

### 2-3. `createPosTerminalPayment`（POS 実行系）★中核
- 役割: 会計1件の PaymentIntent を direct charge で作成 → 指定 reader に process_payment_intent で金額送出。**手数料は §6 の解決順で算出して `application_fee_amount` に設定。**
- 引数: `{ tenantId, spaceId, readerId, orderId, amount, currency:'jpy', contractId?, idempotencyKey }`
  - `orderId` = mobile_order 側の会計ドラフトID（重複決済防止の突合キー）。
  - `idempotencyKey` = POS が会計ドラフト単位に生成（連打しても PI 重複作成しない）。
- 処理: ①`posSales/{piId}` を `status:'processing'` で先行 upsert ②PI 作成（`capture_method:'manual'`）③`readers.processPaymentIntent` ④戻す。
- 戻り: `{ paymentIntentId, status:'processing', clientReferenceId:orderId }`。**結果は Webhook を正**（戻り値は楽観表示のみ）。

### 2-4. `capturePosTerminalPayment`（POS 実行系）
- 役割: 客がタッチ→`requires_capture` になった PI を確定売上化。
- 引数: `{ tenantId, paymentIntentId, amountToCapture? }`（部分キャプチャ対応の余地）
- 戻り: `{ status:'captured' }`。冪等: 既に captured なら no-op。

### 2-5. `refundPosTerminalPayment`（管理/POS 実行系）
- 役割: 取消・返品。Stripe 側 refund と Core 売上の整合（既存の取消/返品・満額表示ロジックとの突合は Phase3）。
- 引数: `{ tenantId, paymentIntentId, amount?, reason? }`（`amount` 省略=全額）
- 戻り: `{ refundId, status }`。冪等キー必須。**不可逆操作＝実行前にユーザー確認**。

> ConnectionToken 発行関数は方式Aでは不要。将来 JS SDK 併用時のみ追加。

---

## 3. Webhook（Connect）

- プラットフォームに **Connect 用 webhook エンドポイント**を1本立てる（`onRequest`, `cors:false`, 署名検証）。
  **既存サブスク課金用 webhook とは別関数・別 signing secret**（`STRIPE_TERMINAL_WEBHOOK_SECRET`）。※現行 Core はまだ Stripe 未導入なので新規だが、mobile_order 側サブスク webhook とはドメイン分離の原則を踏襲。
- 受信イベント（connected account 発 = `event.account` で tenant 逆引き）:
  - `payment_intent.amount_capturable_updated` / `.requires_capture` → `posSales.status='requires_capture'`（客が承認済み、capture 待ち）
  - `payment_intent.succeeded` → `status='succeeded'`、確定売上を書く（§4）
  - `payment_intent.payment_failed` → `status='failed'`＋`errorCode/errorMessage`
  - `payment_intent.canceled` → `status='canceled'`
  - `terminal.reader.action_failed`（端末側失敗）→ `posSales.readerAction.error` 記録
  - `charge.refunded` / `refund.updated` → `posSales.refunds[]` 整合更新
- 冪等: Stripe `event.id` を `webhookEvents/{eventId}` に記録して二重処理防止（**既存 pointEvents アウトボックス/Idempotency-Key 方式と同思想**）。
- tenant 逆引き: `event.account`（acct_…）→ `tenants where billing.stripeAccountId == acct` の索引を持つ（`stripeAccountId` に単一索引 or 逆引きマップ doc）。

---

## 4. 売上レコード `tenants/{tenantId}/posSales/{paymentIntentId}`（**spaceId 必須**）

```jsonc
{
  "paymentIntentId": "pi_…",
  "tenantId": "…",
  "spaceId": "…",            // 必須。拠点別集計の軸
  "contractId": "…",         // 手数料解決の根拠（§6）
  "orderId": "…",            // mobile_order 会計ドラフトID（突合）
  "readerId": "tmr_…",
  "amount": 3300,            // JPY 整数（総額）
  "currency": "jpy",
  "applicationFeeAmount": 99,        // プラットフォーム手数料（実際に取った額）
  "feePercentApplied": 3.0,          // 解決結果の料率（監査用）
  "feeSource": "contract|plan|tenant", // どの階層で解決したか（§6）
  "agencyId": "…",           // 代理店（あれば）
  "agencyShareAmount": 30,   // 代理店取り分（★まず記録のみ・送金しない, §7）
  "status": "processing|requires_capture|captured|succeeded|failed|canceled",
  "errorCode": null, "errorMessage": null,
  "readerAction": { "id": "…", "type": "process_payment_intent", "status": "…", "error": null },
  "refunds": [ { "id": "re_…", "amount": 3300, "reason": "requested_by_customer", "at": "…" } ],
  "createdAt": "…", "updatedAt": "…"
}
```
- mobile_order 側の transaction には成立時に `stripePaymentIntentId` を付与して相互参照。
- 集計は必ず `spaceId` 軸を持つ（tenant 直下フラットでも space フィルタ可能に）。

---

## 5. 手数料解決順（`resolvePosCardFeePercent`）

優先順（先に見つかった値を採用）:
1. **`contract.posCardFeePercent`**（契約に明示された率）
2. **`plan`（プラン既定率）**（`tenant.plan` → プラン定義の `posCardFeePercent`）
3. **`tenant.billing.platform_fee_percent`**（テナント既定/フォールバック）

- `applicationFeeAmount = Math.floor(amount * feePercent / 100)`（JPY 整数・**切り捨て**で過大請求を避ける）。
- 解決に使った階層を `feeSource` に、率を `feePercentApplied` に記録（監査・後追い調整用）。
- どの階層にも値がない場合は **決済を止めてエラー**（暗黙 0% で無手数料にしない）。

---

## 6. 代理店取り分（まず記録のみ）

- Phase1 では Stripe の分配（Separate Transfers / `transfer_data`）は**行わない**。`agencyShareAmount` を `posSales` に**記録するだけ**。
- 後日、記録済みの取り分を月次で集計 → 代理店へ精算（実送金は別フェーズで設計）。
- direct charge（application_fee）と、将来の destination/transfer による代理店分配は **混在可能**（§7 注意）。まずは application_fee のみ実装。

---

## 7. 注意（実装前提）

- **JPY ゼロ小数**: `amount` / `application_fee_amount` は円=整数。小数・×100 変換をしない。
- **Idempotency**: `createPosTerminalPayment` は POS 生成の `idempotencyKey`（会計ドラフト単位）を Stripe 冪等キーに渡す。Webhook は `event.id` で二重処理防止。`orderId` で会計⇄PI を突合し、`processing` 中の再依頼は弾く。
- **App Check**: 現行 Core は未導入。POS 実行系 callable は Core にとって外部呼び出しなので、**App Check enforce ＋ tenant スコープの認可トークン**を新設して保護する（LINE/スタッフ claim とは別系統）。導入は Phase2 の前提タスク。
- **direct と destination の混在 OK**: 本設計は direct charge（`{stripeAccount}` ＋ `application_fee_amount`）。将来、一部を destination charge / transfer に切り替え・併用しても Stripe 上は両立する。設計をどちらかに固定しない。
- **サブスク課金と分離**: Terminal 決済の関数・webhook・secret は既存プラットフォーム課金と物理分離（相互に壊さない）。
- **不可逆操作の確認**: refund・本番キー投入・prod デプロイ前は必ずユーザー確認。まず dev/テストモード＋シミュレートリーダー。

---

## 8. 移植（migration）への反映

現行 Core は tenant=1店舗・space/contract 無し。マルチテナント化の移植 step に以下を織り込む:

- **step3（space 追加）**: `tenants/{t}/spaces/{s}` コレクション新設時に、決済用フィールド
  `stripeTerminalLocationId`（string, null 可）と `readerIds[]` / `readers` サブコレクションを含める。
- **step4（contract 追加）**: `contracts` に **`posCardFeePercent`（料率）** を持たせる。プラン既定率・tenant フォールバック（§5 の 2,3段目）も同時に定義。
- **tenant**: `billing.stripeAccountId` / `billing.platform_fee_percent` を追加（Connect account 参照＋フォールバック率）。
- **Phase2（POS 接続）**: mobile_order POS の「カード」会計確定で Core callable（`createPosTerminalPayment` → `capture`）を呼ぶ。結果は Core `posSales` の onSnapshot / webhook 経由で受け、mobile_order transaction に `stripePaymentIntentId` を付与。

---

## 9. フェーズ計画（更新）

- **Phase0**: 調査・方式決定（済。方式A＋S700）。
- **Phase1（本設計の実装, dev/テストモード）**: Connect account 作成/オンボーディング、`createTerminalLocation` / `registerTerminalReader` / `createPosTerminalPayment` / `capture` / `refund` / Connect webhook、`posSales` スキーマ、手数料解決。**シミュレートリーダーで succeeded まで通す**。
- **Phase2**: mobile_order POS の「カード」会計に接続（App Check 前提整備込み）。dev 検証。
- **Phase3**: 実機 S700 → prod（本番キー・webhook・返金/取消の既存ロジック整合）。代理店実送金の設計。
