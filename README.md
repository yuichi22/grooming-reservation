# ペットトリミング予約 SaaS（groom-reservation-saas）

ペットトリミングサロン向けの **マルチテナント予約 SaaS**。
第一テナント: **GROOM HAUS** / 運営: **DECOLLE Inc.**

顧客は LINE ミニアプリ（LIFF）から予約し、スタッフ・管理者は Web 管理画面で予約・カルテ・シフト・顧客を管理する。決済は予約フローでは行わず、施術後に対面で授受した確定額をカルテに記録する。来店・施術イベントは中央 CRM／ポイント台帳（POS 側）へ `memberId` をキーに送出する。

詳細な設計は [`plan.md`](./plan.md)（元設計: `ペットトリミング予約SaaS 設計書 v1.itmz`）を参照。

## 技術スタック

- **フロントエンド**: React 18 + TypeScript + Vite + React Router
- **バックエンド**: Firebase（Firestore / Auth / Cloud Functions (Node 20) / Hosting）
- **顧客認証**: LINE ログイン・ミニアプリ（LIFF）＋初回に電話番号で会員紐付け
- **スタッフ認証**: Firebase Auth（custom claims で `tenantId` / `role` を制御）
- **テスト**: Vitest（フロント・Functions）＋予約ライフサイクル E2E（エミュレータ）

## 主な画面

| パス | 対象 | 内容 |
|---|---|---|
| `/book`（LIFF） | 顧客 | 予約フロー。`?tenant=` でテナント指定 |
| `/<slug>`（例 `/suomi-matsue`） | 顧客 | 公開 URL からのテナント入口 |
| `/login` `/dashboard` `/bookings` `/karte` `/menus` `/staff` `/shifts` `/customers` `/settings` | スタッフ・管理者 | 管理画面（別チャンクで遅延読込） |

## ディレクトリ構成

```
src/            フロントエンド
  liff/         顧客向け予約フロー（LIFF）
  pages/        スタッフ・管理画面
  auth/         スタッフ認証（Firebase Auth）
  components/   共通 UI
  lib/          Firestore / Functions クライアント
functions/      Cloud Functions（予約枠・予約ポリシー・CRM 連携・リマインド等）＋各種運用スクリプト
docs/           運用手順書（デプロイ / LINE LIFF・リッチメニュー設定 / POS 連携設計）
scripts/        デプロイ検証スクリプト
firestore.rules Firestore セキュリティルール（tenantId スコープ分離）
```

## セットアップ

### 前提

- Node.js 20
- Firebase CLI（`npm i -g firebase-tools` → `firebase login`）
- エミュレータ利用時は Java（macOS: `brew install openjdk`）

### 1. 依存インストール

```bash
npm install
cd functions && npm install && cd ..
```

### 2. 環境変数

`.env.example` をコピーして `.env` を作成し、Firebase Web SDK の設定値（`VITE_FIREBASE_*`）を記入する。dev は `groomhaus-dev`、prod は `groomhaus-prod` のキーを使う（`.env` は git 管理外）。

```bash
cp .env.example .env
```

- `VITE_LIFF_ID` を空にすると、顧客フロー（`/book`）はモック LINE ユーザによる開発モードで動く。
- Functions 側の環境変数は `functions/.env`（`CRM_WEBHOOK_URL` など）。詳細は [`DEPLOY.md`](./DEPLOY.md) を参照。
  **`ALLOW_DEV_LINE_TOKEN` は本番では必ず未設定にすること。**

### 3. 開発サーバー

```bash
npm run dev            # Vite 開発サーバー
```

エミュレータでバックエンドごと動かす場合:

```bash
cd functions && npm run build && cd ..
npm run emulators      # auth / firestore / functions（UI: http://127.0.0.1:4000）
npm run e2e            # 予約ライフサイクル E2E（別ターミナル）
# フロントは .env に VITE_USE_EMULATORS=true を設定して npm run dev
```

## よく使うコマンド

```bash
npm run build          # 型チェック（tsc --noEmit）＋本番ビルド
npm run build:dev      # dev モードビルド
npm run typecheck      # 型チェックのみ
npm run test           # フロントのユニットテスト（vitest）
cd functions && npm run test   # Functions のユニットテスト
```

## デプロイ

```bash
npm run deploy:dev     # dev（groomhaus-dev）へ hosting デプロイ
npm run deploy:prod    # prod（groomhaus-prod）へ hosting デプロイ
npm run deploy:all:dev # hosting / functions / rules / indexes 一括
```

デプロイ後の検証（`npm run check:dev` / `check:prod`）、Functions・ルール・インデックスの個別デプロイ、シークレット運用は [`DEPLOY.md`](./DEPLOY.md) と [`docs/deploy.md`](./docs/deploy.md) を参照。LINE LIFF・リッチメニューの設定手順は [`docs/line-liff-setup.md`](./docs/line-liff-setup.md)。

