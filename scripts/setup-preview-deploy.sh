#!/bin/bash
# GitHub Actions プレビューデプロイの初回セットアップ（1回だけ実行）
# 内容: サービスアカウントへ権限付与 → キー発行 → GitHub Secrets 登録 → キー破棄
set -euo pipefail

PROJECT=groomhaus-dev
REPO=yuichi22/grooming-reservation
SA=github-action-hosting@${PROJECT}.iam.gserviceaccount.com
KEY_FILE=$(mktemp)

echo "== 1/4 IAM ロール付与 =="
for role in roles/firebasehosting.admin roles/firebaseauth.admin roles/run.viewer roles/serviceusage.apiKeysViewer; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${SA}" --role="$role" \
    --condition=None --format=none
  echo "  granted: $role"
done

echo "== 2/4 サービスアカウントキー発行 =="
gcloud iam service-accounts keys create "$KEY_FILE" --iam-account="$SA" --project "$PROJECT"

echo "== 3/4 GitHub Secrets 登録 =="
gh secret set FIREBASE_SERVICE_ACCOUNT_GROOMHAUS_DEV --repo "$REPO" < "$KEY_FILE"
gh secret set ENV_DEV --repo "$REPO" < .env.dev

echo "== 4/4 ローカルのキーを破棄 =="
rm -f "$KEY_FILE"

echo "完了。登録された Secrets:"
gh secret list --repo "$REPO"
