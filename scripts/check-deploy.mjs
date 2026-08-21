// デプロイ検証: 「配信が最新か」と「接続先プロジェクトが正しいか」の2点を見る。
//
// ⚠2つ目が本命。`npm run build`(モード指定なし)は production ビルド＝ groomhaus-prod に
//   つながるバンドルを作る。それを dev の hosting に出すと、**ハッシュは一致するのに
//   dev サイトが prod の Firestore/Auth を見る**という事故になる（2026-08 実際に発生）。
//   entry ハッシュの照合だけでは検出できないため、firebase チャンクの中身まで確認する。
//
// 使い方: node scripts/check-deploy.mjs dev|prod
//   （該当環境向けに build した dist をデプロイした直後に実行する）
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');

const TARGETS = {
  dev: { url: 'https://groomhaus-dev.web.app', projectId: 'groomhaus-dev' },
  prod: { url: 'https://groomhaus-prod.web.app', projectId: 'groomhaus-prod' },
};
const ALL_PROJECT_IDS = ['groomhaus-dev', 'groomhaus-prod'];

const entryOf = (html) => html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null;

/** テキストから登場するプロジェクトIDを拾う */
const projectIdsIn = (text) => ALL_PROJECT_IDS.filter((id) => text.includes(id));

const fail = (msg) => { console.error(`NG: ${msg}`); process.exit(1); };

const main = async () => {
  const env = (process.argv[2] || '').trim();
  const target = TARGETS[env];
  if (!target) {
    console.error('usage: node scripts/check-deploy.mjs dev|prod');
    process.exit(2);
  }
  console.log(`env   : ${env} (${target.url})`);
  console.log(`期待する接続先: ${target.projectId}`);

  // --- 1) ローカル dist の接続先を確認（デプロイ前でも気づけるように、まずこちらを見る） ---
  let localIndexHtml;
  try {
    localIndexHtml = readFileSync(join(DIST, 'index.html'), 'utf8');
  } catch {
    console.error('NG: dist/index.html がありません。先に build してください。');
    process.exit(2);
  }
  const localEntry = entryOf(localIndexHtml);
  if (!localEntry) fail('dist/index.html に entry が見つかりません。');

  const assetFiles = readdirSync(join(DIST, 'assets')).filter((f) => f.endsWith('.js'));
  const localHits = new Map(); // fileName -> [projectId]
  for (const f of assetFiles) {
    const ids = projectIdsIn(readFileSync(join(DIST, 'assets', f), 'utf8'));
    if (ids.length) localHits.set(f, ids);
  }
  if (localHits.size === 0) {
    fail('ローカル dist からプロジェクトIDが見つかりません（バンドル構成が変わった可能性）。');
  }
  const localIds = [...new Set([...localHits.values()].flat())];
  console.log(`local : ${localEntry} / 接続先 ${localIds.join(', ')}`);
  if (localIds.length !== 1 || localIds[0] !== target.projectId) {
    const hint = env === 'dev'
      ? '    → `npm run deploy:dev` を使ってください。⚠`npm run build`(モード指定なし)は prod 向けです。'
      : '    → `npm run deploy:prod` を使ってください。⚠dev 向け build を prod に出そうとしています。';
    fail(
      `ローカル build の接続先が ${localIds.join(', ')} です（期待: ${target.projectId}）。\n${hint}`
    );
  }

  // --- 2) 配信中のものが、そのローカル build かどうか ---
  const res = await fetch(`${target.url}/?_=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
  const liveEntry = entryOf(await res.text());
  console.log(`live  : ${liveEntry}`);
  if (localEntry !== liveEntry) {
    fail('配信中の entry がローカルと一致しません（デプロイされていない / 取り残し）。');
  }

  // --- 3) 配信中のチャンクの中身も確認（ハッシュ一致だけでは接続先の取り違えを見逃す） ---
  for (const [file] of localHits) {
    const r = await fetch(`${target.url}/assets/${file}?_=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) fail(`配信中の /assets/${file} を取得できません (${r.status})。`);
    const ids = projectIdsIn(await r.text());
    if (ids.length !== 1 || ids[0] !== target.projectId) {
      fail(`配信中の ${file} の接続先が ${ids.join(', ') || '(不明)'} です（期待: ${target.projectId}）。`);
    }
    console.log(`  ${file} -> ${ids[0]}`);
  }

  console.log(`OK: ローカルの build が配信され、接続先も ${target.projectId} で正しいです。`);
};

main().catch((e) => { console.error('NG: チェック失敗:', e?.message || e); process.exit(2); });
