# デプロイ / 運用ガイド (§12 / §4 / §11)

## 環境 (dev / prod)

`.firebaserc` のエイリアス:

| エイリアス | Firebase プロジェクト |
|---|---|
| `dev`（既定） | `groomhaus-dev` |
| `prod` | `groomhaus-prod` |

フロントの Firebase 設定は `.env`（`VITE_*`）で切り替え（dev/prod それぞれの値を設定）。`.env` は git 管理外。

## 事前準備

```bash
npm install --cache "$PWD/.npm-cache"          # ルート（~/.npm 権限回避）
cd functions && npm install --cache "$PWD/../.npm-cache" && cd ..
firebase login
```

## ローカル動作確認（エミュレータ）

Java が必要（macOS 例）:

```bash
brew install openjdk
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
```

```bash
cd functions && npm run build && cd ..
npm run emulators          # auth/firestore/functions（UI: http://127.0.0.1:4000）
npm run e2e                # 予約ライフサイクル E2E（別ターミナル）
# フロント: .env に VITE_USE_EMULATORS=true → npm run dev
```

## デプロイ

```bash
npm run deploy:dev         # build → firebase deploy（hosting/functions/firestore rules+indexes）
npm run deploy:prod        # 本番
```

個別デプロイ例: `firebase deploy --only firestore:rules --project prod` / `--only functions:createBooking`。

## シークレット / 環境変数（Functions）

`functions/.env`（`functions/.env.example` 参照）。本番のトークン類は **Secret Manager** 推奨。

| 変数 | 用途 | 未設定時 |
|---|---|---|
| `CRM_WEBHOOK_URL` | §10 中央台帳への配信先 | `pointEvents` に pending で滞留（CRM 構築後に設定→`retryPointEvents` が回収配信） |
| `LINE_CHANNEL_ACCESS_TOKEN` | §9 リマインドのプッシュ（単一テナント時のフォールバック） | 送信せず skip |

テナント単位の値は `tenants/{tenantId}.lineConfig.messagingChannelAccessToken` を優先。

## スケジュール関数

- `sendReminders`: 毎日 18:00 (Asia/Tokyo) 前日リマインド (§9)
- `retryPointEvents`: 30分毎に §10 イベント再送

デプロイ時に Cloud Scheduler ジョブが自動作成される。エミュレータでは pubsub 未起動のため動かない（`sendRemindersNow` で手動テスト）。

## テナント発行・スタッフ権限 (§4 / §2)

外販時は各サロンが自社 LINE プロバイダーを持つ（顧客 userId は各社別空間）。発行フロー:

1. superAdmin が `createTenant`（`tenants/{tenantId}` 作成）を実行。
2. `tenants/{tenantId}.lineConfig` に providerId / miniAppChannelId / messagingApiChannelId / liffId を設定。
3. `setStaffRole` でスタッフの Firebase Auth uid に custom claims（tenantId / role）を付与。

## 初回データ投入（dev）

新規 Firebase プロジェクトは **Authentication を初回だけ Console で初期化が必要**
（API/Admin SDK では `configuration-not-found` になる）:

1. Console → Authentication →「始める」→ Sign-in method で **メール/パスワード**を有効化。
2. シード（superAdmin / テナント / スタッフ / メニュー）を Admin SDK で投入:
   ```bash
   gcloud iam service-accounts keys create /tmp/sa.json \
     --iam-account=firebase-adminsdk-fbsvc@groomhaus-dev.iam.gserviceaccount.com --project groomhaus-dev
   SEED_PASSWORD='<dev用パスワード>' GOOGLE_APPLICATION_CREDENTIALS=/tmp/sa.json \
     node functions/seed-dev.mjs
   # 後始末（重要・長期鍵を残さない）:
   gcloud iam service-accounts keys delete <KEY_ID> \
     --iam-account=firebase-adminsdk-fbsvc@groomhaus-dev.iam.gserviceaccount.com --project groomhaus-dev -q
   rm -f /tmp/sa.json
   ```
   作成アカウント: `super@ / admin@ / trimmer@groomhaus.dev`（パスワードは `SEED_PASSWORD`）。

## 未確定（§11 要決定）

- 初回電話番号の本人確認（入力のみ / SMS OTP）— 現状は **入力のみ**。
- リマインド文面・送信時刻 — 暫定（前日18:00・固定文面）。
- キャンセル締切 `settings.cancelDeadlineHours` の既定値（現状 **24h**）。
