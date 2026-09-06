# デプロイ手順

## 鉄則

**画面(hosting)を出すときは必ず `npm run deploy:dev:verify` / `deploy:prod:verify` を使う。**
`npm run build` と `firebase deploy` を別々に叩かない。

理由: `npm run build` は**モード指定なし＝production ビルド**で、`.env.production`
(=`groomhaus-prod`)を読み込む。これを dev の hosting に出すと、
**entry のハッシュは一致するのに dev サイトが prod の Firestore/Auth を見る**という事故になる。

実際に 2026-08 に発生した。症状は分かりにくい:

- dev のセッションが切れてログアウトする（認証プロジェクトが変わるため）
- スタッフ一覧に dev のテストトリマーではなく prod のスタッフが出る
- カルテも prod のものが見える

`deploy:*:verify` は `scripts/check-deploy.mjs` で次の3点を見るので、これを防げる。

1. **ローカル dist の接続先が環境と一致するか**（デプロイ前に止まる）
2. 配信中の entry がローカルと一致するか（取り残し検出）
3. **配信中の firebase チャンクの中身**が期待どおりのプロジェクトか

※ 1 と 3 が肝。**entry ハッシュの照合だけでは今回の事故は検出できない**（ハッシュは一致していた）。

## コマンド

| 用途 | dev | prod |
|---|---|---|
| 画面(hosting) | `npm run deploy:dev:verify` | `npm run deploy:prod:verify` |
| 配信の確認だけ | `npm run check:dev` | `npm run check:prod` |
| Functions 全部 | `npm run deploy:fn:dev` | `npm run deploy:fn:prod` |
| Firestore ルール | `npm run deploy:rules:dev` | `npm run deploy:rules:prod` |
| Firestore インデックス | `npm run deploy:idx:dev` | `npm run deploy:idx:prod` |
| 全部（明示的に） | `npm run deploy:all:dev` | `npm run deploy:all:prod` |

`deploy:dev` / `deploy:prod` は **hosting のみ**に絞ってある。
以前は `--only` が無く、hosting・functions・Firestoreルール・インデックスが道連れで出ていた。

### Functions は単一関数の指定が最も安全

追加デプロイなので他の関数を壊さない。関数を1本だけ直したときはこちら。

```bash
npx firebase deploy --only functions:completeBooking --project dev
```

## 環境変数

| ファイル | 用途 |
|---|---|
| `.env.dev` | `build:dev` が読む。`groomhaus-dev` |
| `.env.production` | `build`(素) が読む。`groomhaus-prod` |
| `functions/.env.groomhaus-dev` | dev の Functions 環境変数 |
| `functions/.env.groomhaus-prod` | prod の Functions 環境変数 |
| `functions/.env.local` | ローカル/エミュレータ用 |

いずれも git 管理外。

**`ALLOW_DEV_LINE_TOKEN` はデプロイ済み環境には置かないこと。**
`accessToken: "dev:U<任意>"` で任意の LINE ユーザーになりすませてしまう。
ローカル/E2E で必要なときだけ `functions/.env.local` に置く。
