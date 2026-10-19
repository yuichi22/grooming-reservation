# grooming-reservation 開発ルール

ペットトリミング予約 SaaS（第一テナント GROOM HAUS）。dev = `groomhaus-dev` / prod = `groomhaus-prod`。
設計は `plan.md`、運用手順は `DEPLOY.md` と `docs/`。

## prod の操作（最重要）

- **prod は必ず main から出す。** hosting・functions とも `firebase.json` の predeploy で
  `scripts/guard-prod-deploy.mjs` が動き、main 以外のブランチ / デプロイに載るファイルの未コミット変更 /
  origin/main より古い main、のいずれかで**自動中止**する。
  迂回（`AKUTO_FORCE_PROD_DEPLOY=1`）はユーザーが明示的に指示した緊急時のみ。使ったら必ず報告する。
- **prod への操作は、実行前に内容（何を・どのコマンドで・影響範囲）を伝えてユーザーの確認を取る。**
  対象: デプロイ（hosting / functions / rules / indexes）、本番データへの書き込みスクリプト
  （`functions/*.mjs prod` 系）、PR のマージ。
- prod の hosting は GitHub Actions「Prod Deploy (manual)」（main 限定）から出すのが標準。
  functions / rules / indexes は main 上で `npm run deploy:fn:prod` / `deploy:rules:prod` / `deploy:idx:prod`。
  Functions は可能なら `firebase deploy --only functions:<名前> --project prod` で必要な関数だけ置き換える。

## 標準フロー

1. 作業ブランチで実装 → `npm run typecheck` / `npm test` / `npm run build:dev`
2. dev で確認: `npm run deploy:dev:verify`（build＋deploy＋配信一致チェック）。functions は `npm run deploy:fn:dev`
3. PR を作り、ユーザーがマージ
4. main で prod（上の「prod の操作」に従い、確認を取ってから）

## Functions の環境変数

- `functions/.env`（全プロジェクト共通＝prod にも乗る）/ `functions/.env.groomhaus-dev` / `functions/.env.groomhaus-prod`。
  いずれも gitignore。**worktree や新しい環境には付いてこない**ので、functions を出す前に存在を確認する。
- ⚠ `ALLOW_DEV_LINE_TOKEN` は認証バイパス。**`.env` と prod には絶対に書かない**（`.env.groomhaus-dev` / `.env.local` のみ）。

## その他

- Firestore は `(default)` DB の1本。ルールは `firebase deploy --only firestore:rules` で配信できる。
- シークレット（鍵・トークン・env ファイルの中身）はリポジトリに置かない。画面にも出さない。
