// リッチメニューの確認/設定（LINE Messaging API）。
// 全面タップ→素の LIFF（?tenant= なし）を開く＝/book の店舗解決(BookEntry)に乗せる。
//
// 使い方:
//   MODE=get   MESSAGING_TOKEN=xxx node functions/set-richmenu.mjs
//     → 既存のリッチメニュー一覧・既定・各エリアの遷移先URLを表示（変更なし）
//   MODE=set   MESSAGING_TOKEN=xxx LIFF_ID=2010431019-EJ1xAj6t IMAGE=/tmp/richmenu-prod.png \
//              node functions/set-richmenu.mjs
//     → 画像付きで作成→既定に設定→古い既定は削除。URLは https://liff.line.me/<LIFF_ID>（素）
//
// 注意: 本番OAに対して実行すると即時反映。トークン(MESSAGING_TOKEN)は使い捨て前提で扱う。

import { readFileSync } from 'node:fs';

const TOKEN = process.env.MESSAGING_TOKEN;
const MODE = process.env.MODE || 'get';
if (!TOKEN) throw new Error('MESSAGING_TOKEN required');

const API = 'https://api.line.me/v2/bot';
const DATA = 'https://api-data.line.me/v2/bot';
const auth = { Authorization: `Bearer ${TOKEN}` };

async function j(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method || 'GET'} ${url} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function showCurrent() {
  const list = await j(`${API}/richmenu/list`, { headers: auth });
  let defaultId = null;
  try {
    defaultId = (await j(`${API}/user/all/richmenu`, { headers: auth })).richMenuId ?? null;
  } catch {
    /* 既定未設定 */
  }
  console.log(`richmenus: ${list.richmenus.length}, default=${defaultId ?? '(none)'}`);
  for (const m of list.richmenus) {
    const uris = (m.areas || []).map((a) => a.action?.uri || `${a.action?.type}`).join(' , ');
    console.log(`  ${m.richMenuId}${m.richMenuId === defaultId ? ' [default]' : ''}  name="${m.name}"  size=${m.size.width}x${m.size.height}  ->  ${uris}`);
  }
  return { list, defaultId };
}

if (MODE === 'get') {
  await showCurrent();
  process.exit(0);
}

if (MODE === 'set') {
  const LIFF_ID = process.env.LIFF_ID;
  const IMAGE = process.env.IMAGE;
  if (!LIFF_ID) throw new Error('LIFF_ID required for set');
  if (!IMAGE) throw new Error('IMAGE (png path) required for set');
  const uri = `https://liff.line.me/${LIFF_ID}`; // 素のLIFF＝?tenant=なし

  const { defaultId: prevDefault } = await showCurrent();

  // 1) 作成（2500x843 / 全面1エリア）
  const created = await j(`${API}/richmenu`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      size: { width: 2500, height: 843 },
      selected: true,
      name: `予約メニュー ${new Date().toISOString().slice(0, 10)}`,
      chatBarText: '予約メニュー',
      areas: [{ bounds: { x: 0, y: 0, width: 2500, height: 843 }, action: { type: 'uri', uri } }],
    }),
  });
  const id = created.richMenuId;
  console.log(`created ${id} -> ${uri}`);

  // 2) 画像アップロード
  const png = readFileSync(IMAGE);
  await j(`${DATA}/richmenu/${id}/content`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'image/png' },
    body: png,
  });
  console.log(`uploaded image (${png.length} bytes)`);

  // 3) 既定に設定
  await j(`${API}/user/all/richmenu/${id}`, { method: 'POST', headers: auth });
  console.log(`set as default: ${id}`);

  // 4) 旧既定を削除（任意・残骸防止）
  if (prevDefault && prevDefault !== id) {
    await j(`${API}/richmenu/${prevDefault}`, { method: 'DELETE', headers: auth });
    console.log(`deleted old default: ${prevDefault}`);
  }

  console.log('\n--- after ---');
  await showCurrent();
  process.exit(0);
}

throw new Error(`unknown MODE: ${MODE}`);
