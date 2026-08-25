/**
 * テナントOAにリッチメニューを配備する（接続手順の一部）。
 *
 * 使い方:
 *   node functions/setup-richmenu.mjs <dev|prod> <tenantId> <image.png> [cardLiffId]
 *
 * - cardLiffId 省略時: 「予約する」1ボタン（画像は1ボタン用を渡すこと）
 * - cardLiffId 指定時: 「予約する│会員証」2ボタン（画像は2ボタン用）
 * - 予約リンクは各環境の予約LIFF( https://liff.line.me/{BOOK_LIFF}?tenant={tenantId} )
 * - 既存の "groom-standard-*" メニューは置き換える（増殖させない）
 */
import { readFileSync } from 'node:fs';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECTS = { dev: 'groomhaus-dev', prod: 'groomhaus-prod' };
// ⚠会員証(/card)の tenantId は Core CRM 側のテナントID(crmSources の coreTenantId)。
//   groom のテナントIDを渡すと全員「まだ会員登録がありません」になる。
const CORE_PROJECTS = { dev: 'suomin-9ff5a', prod: 'suomin-prod' };
// 予約LIFF(環境ごと)。dev は .env.dev の VITE_LIFF_ID と同じ値。
const BOOK_LIFF = { dev: '2010427516-pML6ldSE', prod: null }; // prod は接続時に確認して埋める
const CARD_BASE = { dev: 'https://suomin-admin.web.app', prod: 'https://suomin-admin-54858.web.app' };

const [env, tenantId, imagePath, cardLiffId] = process.argv.slice(2);
const projectId = PROJECTS[env];
if (!projectId || !tenantId || !imagePath) {
  console.error('使い方: node functions/setup-richmenu.mjs <dev|prod> <tenantId> <image.png> [cardLiffId]');
  process.exit(1);
}
if (!BOOK_LIFF[env]) { console.error(`${env} の予約LIFF IDが未設定です(このスクリプト冒頭のBOOK_LIFF)`); process.exit(1); }

const app = initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore(app);
const token = (await db.doc(`tenants/${tenantId}`).get()).get('lineConfig.messagingChannelAccessToken');
if (!token) { console.error(`${tenantId}: messagingChannelAccessToken がありません`); process.exit(1); }

// 会員証リンク用に Core 側テナントIDを解決（2ボタン時のみ必要）
let coreTenantId = null;
if (cardLiffId) {
  const coreApp = initializeApp({ credential: applicationDefault(), projectId: CORE_PROJECTS[env] }, 'core');
  const src = await getFirestore(coreApp).doc(`integrations/crmSources/sources/${tenantId}`).get();
  coreTenantId = src.exists ? String(src.data().coreTenantId) : null;
  if (!coreTenantId) { console.error(`crmSources に ${tenantId} のマッピングがありません(会員証リンクを作れない)`); process.exit(1); }
  console.log(`会員証の Core テナント: ${coreTenantId}`);
}

const api = async (host, path, opts = {}) => {
  const res = await fetch(`https://${host}.line.me${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${body}`);
  return body ? JSON.parse(body) : {};
};

// どのOAか確認してから触る（本番OA誤爆防止で必ず表示する）
const bot = await api('api', '/v2/bot/info', {});
console.log(`対象OA: ${bot.displayName} (${bot.basicId})  project=${projectId} tenant=${tenantId}`);

const bookUrl = `https://liff.line.me/${BOOK_LIFF[env]}?tenant=${tenantId}`;
const W = 2500, H = 843;
const name = cardLiffId ? 'groom-standard-2btn' : 'groom-standard-1btn';
const menu = {
  size: { width: W, height: H },
  selected: true, // 初期表示で開いておく
  name,
  chatBarText: 'メニュー',
  areas: cardLiffId
    ? [
        { bounds: { x: 0, y: 0, width: W / 2, height: H }, action: { type: 'uri', label: '予約する', uri: bookUrl } },
        { bounds: { x: W / 2, y: 0, width: W / 2, height: H }, action: { type: 'uri', label: '会員証',
            uri: `https://liff.line.me/${cardLiffId}?liffId=${cardLiffId}&tenantId=${coreTenantId}` } },
      ]
    : [ { bounds: { x: 0, y: 0, width: W, height: H }, action: { type: 'uri', label: '予約する', uri: bookUrl } } ],
};

// 旧 groom-standard-* を掃除(このスクリプトが作ったものだけ消す)
const { richmenus = [] } = await api('api', '/v2/bot/richmenu/list', {});
for (const m of richmenus) {
  if (String(m.name).startsWith('groom-standard-')) {
    await api('api', `/v2/bot/richmenu/${m.richMenuId}`, { method: 'DELETE' });
    console.log(`旧メニュー削除: ${m.name} (${m.richMenuId})`);
  }
}

const { richMenuId } = await api('api', '/v2/bot/richmenu', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(menu),
});
console.log(`作成: ${name} -> ${richMenuId}`);
await api('api-data', `/v2/bot/richmenu/${richMenuId}/content`, {
  method: 'POST', headers: { 'Content-Type': 'image/png' }, body: readFileSync(imagePath),
});
console.log('画像アップロード完了');
await api('api', `/v2/bot/user/all/richmenu/${richMenuId}`, { method: 'POST' });
console.log('デフォルトメニューに設定完了');

// 検証: デフォルトが今作ったものか
const def = await api('api', '/v2/bot/user/all/richmenu', {});
console.log(def.richMenuId === richMenuId ? '✅ 検証OK: デフォルト=作成メニュー' : `❌ 検証NG: ${def.richMenuId}`);
console.log(`\n予約リンク: ${bookUrl}`);
if (cardLiffId) console.log(`会員証リンク: https://liff.line.me/${cardLiffId}?liffId=${cardLiffId}&tenantId=${coreTenantId}`);
