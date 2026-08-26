# LINE LIFF・リッチメニュー設定手順書

groom予約 と 会員証(/card) を LINE から開くための設定一式。
新しい環境・新しいテナントOAを接続するときはこの手順書に従う。

## 全体図

```
LINE Developers プロバイダー: DECOLLE Inc.
├─ ログインチャネル (dev: 2010427516 / prod: 2010431019)
│   ├─ LIFF「groom予約」 … endpoint = 予約アプリ /book
│   └─ LIFF「会員証」   … endpoint = Core /card       ← この手順書で作るもの
├─ Messaging APIチャネル: 共有OA「groom予約」
└─ Messaging APIチャネル: 各テナントの専用OA (例: GROOM HAUS @853atgck)
```

- lineUserId は**プロバイダー単位**。LIFF もOAも同じプロバイダーに置く限り、
  どこから認証しても同じお客様として名寄せされる。
- 「会員証」LIFF は**全テナント共通で1つ**。テナントの区別はリッチメニューの
  リンクURLに載る `tenantId`(Core側のID)で行う。

## 環境ごとの値

| | dev | prod |
|---|---|---|
| ログインチャネル | 2010427516 | 2010431019 |
| 予約LIFF | 2010427516-pML6ldSE | 2010431019-EJ1xAj6t |
| 会員証LIFF | 2010427516-dJa8I1jp | **（作成したらここに記入）** |
| 会員証 endpoint | https://suomin-admin.web.app/card | https://suomin-admin-54858.web.app/card |
| Core プロジェクト | suomin-9ff5a | suomin-prod |
| groom プロジェクト | groomhaus-dev | groomhaus-prod |

値の出どころ: 予約LIFF = groom リポジトリの `.env.dev` / `.env.production` の `VITE_LIFF_ID`。

## 手順1: 会員証LIFFを作る（LINE Developersコンソール・約3分）

1. https://developers.line.biz/console/ にログイン
2. プロバイダー **DECOLLE Inc.** → **ログインチャネル**（prod なら `2010431019`。
   ⚠Messaging APIチャネルではない）
3. **LIFF タブ → 追加**
4. 設定値:

| 項目 | 値 | 理由 |
|---|---|---|
| LIFFアプリ名 | `会員証` | お客様の目に触れることがある。店名は入れない（全店共通のため） |
| サイズ | **Full** | カード全体を見せる |
| エンドポイントURL | 上の表の「会員証 endpoint」 | ⚠dev/prodを取り違えない |
| Scope | **profile のみ**（openid は付いても害なし） | サーバが `/v2/profile` で userId を解決する。chat_message.write 不要 |
| 友だち追加オプション | **なし（オフ）** | チャネルにリンクできるOAは1つだけで、全テナント共通LIFFに特定の店のOAは紐付けられない。友だち追加案内はアプリ内の `addFriendUrl`（テナント別）が担う |
| Scan QR | オフ | /card はスキャンしない（読むのはレジのスキャナ側） |
| モジュールモード | オフ | 通常のLIFFとしてリッチメニューから開くだけ |

5. 作成すると `2010431019-XXXXXXXX` 形式の **LIFF ID** が発行される → 上の表に記入

## 手順2: リッチメニューを配備する

groom リポジトリで:

```bash
node functions/setup-richmenu.mjs prod <テナントID> <画像パス> <会員証LIFF ID>
```

例（GROOM HAUS・2ボタン版）:

```bash
node functions/setup-richmenu.mjs prod groomhaus richmenu-2btn.png 2010431019-XXXXXXXX
```

- 画像は 2500×843 の PNG。2ボタン標準画像の生成コードはセッション記録参照
  （PIL で生成。⚠ヒラギノに絵文字グリフが無いのでアイコンは図形で描く）
- スクリプトは対象OA名を表示してから触る（本番OA誤爆防止）。
  `groom-standard-*` という名前のメニューだけを置き換え、他は触らない
- 会員証リンクの `tenantId` は **Core側のID**（`integrations/crmSources` の
  `coreTenantId`）をスクリプトが自動解決する。groom側のIDを手で入れないこと
  （全員「まだ会員登録がありません」になる）

## 手順3: 検証

1. 対象OAのトークを開き、下部にリッチメニューが出ること
2. **予約する** → 予約LIFFが開く
3. **会員証** → 初回は profile の許可画面 → カード表示
   - 初回はLINE側のLIFF起動で数秒かかる（仕様・消せない）。表示後は
     カードトークン＋キャッシュで2回目以降は即表示
4. Core の関数ログにエラーが無いこと:
   `gcloud logging read '... service_name="getmypointcard" AND severity>=ERROR' --project=<Coreプロジェクト> --freshness=15m`

## トラブルシュート

| 症状 | 原因と対処 |
|---|---|
| 「リンクが正しくありません（tenantId がありません）」 | URL直叩きで `?tenantId=` が無い。リッチメニュー経由なら liff.state 剥がし実装済みなので出ないはず。出たら hosting が古い |
| 全員「まだ会員登録がありません」 | 会員証リンクの tenantId が groom側IDになっている。手順2の注意参照 |
| 「この端末ではご利用いただけません（LIFF ID がありません）」 | URL直叩き。LIFF経由（liff.line.me/{ID}?…）で開く |
| 初回だけ数秒待つ | LINE側のLIFF起動時間（実機診断で確定・コード実行前の時間）。仕様として受容。恒久対策はトーク内Flex会員証（タスク化済み） |
| デプロイしたのに /card が変わらない | /card /liff のHTMLは max-age=300+SWR。最大5分＋裏更新1回分の遅れは正常。⚠管理画面まで同じヘッダにしないこと |

## 関連

- OA接続の全体手順（管理者招待→Messaging API→lineConfig→この手順書）: memory `groom-line-oa-split`
- LIFF実機の罠（トークン失効・liff.login禁止・liff.state・webviewコールドスタート）: memory `akuto-crm-line-points`
