# ペットトリミング予約SaaS — 実装計画 (v1)

第一テナント: **GROOM HAUS** / 運営: **DECOLLE Inc.**
元設計: `ペットトリミング予約SaaS 設計書 v1.itmz`（iThoughts マインドマップ）

---

## 1. 設計書サマリ

### 目的・方針 (§1)
- ペットトリミング予約を扱う **マルチテナント SaaS**。将来は他サロンへ外販可能な汎用設計。
- スタック: **React**（フロント）/ **Firebase**（Firestore・Auth・Cloud Functions・Hosting）/ **LINE ログイン・ミニアプリ**（顧客認証）。既存 QR 解錠 SaaS と同じ作法に揃える。
- 顧客認証: **LINE ログイン主体＋初回に電話番号を取得して会員に紐づけ**。
- 決済: **予約フローでは使わない**。施術後に対面で確定額を授受し、カルテに記録。
- 環境: **dev / prod 分離**（Firebase プロジェクト別、LINE ミニアプリ開発用／本番用）。
- 連携: 来店・施術イベントを **中央 CRM／ポイント台帳（POS 側）へ送出**（キー = `memberId`）。本 SaaS は「イベントを投げる側」。
- 役割分担: 本 SaaS は構想全体の「スポーク1本」。**名寄せ・ポイント集計はやらない**。

### 認証設計 (§2)
- 顧客: LIFF（`liff.init()` → `liff.login()`）で **LINE userId** 取得。初回のみ電話番号取得 → `memberId` 紐付け。
- スタッフ・管理者: Firebase Auth（email/password or 電話）。custom claims に `tenantId` と `role`(admin/trimmer)。
- スーパーアドミン: custom claims `superAdmin: true`。テナント発行・プラン・状態を管理。
- セキュリティ: Firestore Rules で **tenantId スコープ**完全分離＋ロールベース制御。

### 会員ID・名寄せ (§3)
- マスターキー = 自社発行 **memberId**（内部ID）。電話/userId を主キーにしない。
- リンク識別子: `lineUserId`（DECOLLE プロバイダー由来）、`phone`（Firebase 電話認証）。
- **ポイント会員 = LINE 連携済み会員**。付与は連携後の利用分から（遡及なし）。
- find-or-link: 取得できた識別子で既存会員照合 → 一致なら識別子を追加（新規作成しない）。
- 会員バーコードは memberId 直値ではなく短時間トークン（スクショ悪用防止）。

### マルチテナント構造 (§4)
- スーパーアドミンが tenant を発行。テナント = サロン単位。custom claims `tenantId` で識別。
- LINE 設定はテナントごと保持（`providerId` / `miniAppChannelId` / `messagingApiChannelId` / `liffId`）。

### データモデル (§5) — Firestore
```
superAdmins/{uid}
tenants/{tenantId}
  name, plan, status
  lineConfig: { providerId, miniAppChannelId, messagingApiChannelId, liffId }
  settings: { timezone, businessHours[], bufferMin, workTimeOptions:[50,80,110] }
tenants/{tenantId}/staff/{staffId}        name, role, active, firebaseUid
tenants/{tenantId}/menus/{menuId}         name, defaultDurationMin, fixedDuration, price, active
tenants/{tenantId}/customers/{customerId} memberId, ownerName, phone?, lineUserId?, createdAt
tenants/{tenantId}/dogs/{dogId}           customerId, name, breed, size, notes, allergies,
                                          confirmedDurationMin(null可), confirmedPrice, lastServiceAt
tenants/{tenantId}/dogs/{dogId}/records/{recordId}  bookingId, date, menuId, staffId, durationMin, price, notes
tenants/{tenantId}/bookings/{bookingId}   dogId, customerId, menuId, staffId, date, startTime,
                                          durationMin, bufferMin, slotEnd,
                                          status('reserved'|'done'|'canceled'|'noshow'),
                                          finalDurationMin?, finalPrice?, createdAt
```

### 予約スロット計算 (§6) — コアロジック
```
effectiveDuration(dog, menu):
  if menu.fixedDuration: return menu.defaultDurationMin   # 例: シャンプー=50分固定
  else:                  return dog.confirmedDurationMin ?? menu.defaultDurationMin

need = effectiveDuration + tenant.settings.bufferMin

availability(date, staffScope):
  occupied  = 対象の既存 bookings（slotEnd 込み）
  freeGaps  = businessHours − occupied
  for gap in freeGaps:
    出力 = { start | gap.start ≤ start かつ start+need ≤ gap.end }（grid step 例:15分）
```
- 作業時間は `workTimeOptions`(50/80/110) から選択。**フリー入力不可**。
- 例（buffer 10分）: 9:00–10:00 と 11:00–13:00 が予約済 → 10:00–11:00 の 60 分枠は
  50 分の犬(need=60)は表示、80 分の犬(need=90)は非表示。シャンプー(50分固定)なら 80 分の犬でも表示。

### 作業時間オーバーライド・フロー (§7)
初回=null(標準/最大枠) → 来店時メモ → 施術後に確定(`confirmedDurationMin`/`confirmedPrice` 更新・records 追記・booking done) → 次回は確定値を自動適用。

### 指名予約 (§8)
指名あり=そのスタッフのみで空き計算。指名なし=全スタッフ和集合 → 確定時に空きスタッフ割当。

### リマインド (§9)
Cloud Functions + Cloud Scheduler で翌日分 bookings 抽出 → LINE Messaging API でプッシュ。無断キャンセル抑制。

### ポイント台帳連携 (§10)
`status=done` かつ `finalPrice` 確定時に中央 CRM/POS へイベント送出。
ペイロード例: `{ memberId, tenantId, brand:"GROOM HAUS", type:"trimming", amount, at }`。冪等性に注意。

### 検討事項 (§11) / 環境分離 (§12)
電話番号取得方式、中央台帳 API スキーマ・冪等性、手動マージ UI、リマインド文面・時刻、キャンセルポリシー、営業時間例外。
dev=`groomhaus-dev` / prod=`groomhaus-prod`。Stripe は当面未使用。

---

## 2. マイルストーン分解

### M0 — プロジェクト基盤（本コミット）
- [x] Vite + React + TypeScript 雛形
- [x] Firebase 初期化・`firebase.json` / `.firebaserc`(dev/prod) / Firestore Rules 雛形
- [x] §6 スロット計算ロジック + 単体テスト（Vitest）

### M1 — データモデルとテナント基盤
- [x] Firestore コレクション型定義の整備（§5）— `src/lib/types.ts` 全コレクション + `src/lib/firestore.ts` 型付き参照
- [x] テナント別 tenantId スコープの Rules を本実装＋ロールベース制御 — `firestore.rules`（設定系=admin / カルテ=trimmer 可）
- [x] スーパーアドミンによるテナント発行 Function — `functions/src/index.ts` `createTenant` / `setStaffRole`

### M2 — スタッフ/管理者 認証・管理画面
- [ ] Firebase Auth + custom claims(tenantId / role)
- [ ] メニュー・スタッフ・営業時間設定 UI（admin）
- [ ] カルテ（dogs / records）閲覧・編集（trimmer 可）

### M3 — 顧客予約フロー（LIFF）
- [ ] LIFF 初期化・LINE ログイン・初回電話番号取得 → find-or-link(§3)
- [ ] メニュー選択・指名(§8)・§6 空きスロット表示・予約確定
- [ ] confirmedDurationMin オーバーライド・フロー(§7)

### M4 — 施術完了・台帳連携
- [ ] 施術後の確定時間/料金入力 → booking done / records 追記
- [ ] 中央 CRM/POS へのイベント送出 Function（冪等性・リトライ）(§10)

### M5 — リマインド通知
- [ ] Cloud Scheduler + Function で前日通知（LINE Messaging API）(§9)

### M6 — 運用・外販対応
- [ ] dev/prod デプロイパイプライン(§12)
- [ ] テナント別 LINE プロバイダー設定の運用フロー(§4/§11)
- [ ] 手動マージ UI・キャンセルポリシー等(§11)

---

## 3. ディレクトリ構成（現時点）
```
.
├── plan.md
├── index.html
├── package.json
├── tsconfig.json / tsconfig.node.json
├── vite.config.ts
├── firebase.json / .firebaserc
├── firestore.rules / firestore.indexes.json
├── .env.example / .gitignore
└── src/
    ├── main.tsx / App.tsx
    ├── firebase.ts
    └── lib/
        ├── types.ts        # §5 データモデルの型
        ├── slots.ts        # §6 スロット計算ロジック
        └── slots.test.ts   # §6 例の単体テスト
```
