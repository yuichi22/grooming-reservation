/**
 * 共有 LINE 公式アカウントの通数を集計する（運営用）。
 *
 * ⚠LINE の請求は「公式アカウント単位」でしか出ない。共有 OA は全テナントで
 * 1つの通数枠を食い合うので、どの店がどれだけ使っているかは自前で集計するしかない。
 *
 * スタンダードプラン: 月額15,000円(税別)に30,000通が含まれ、超過分は1通3円。
 * 30,000通の手前では1通あたりの限界コストは0円なので、「何通で専用OAへ誘導するか」は
 * テナント単体の通数ではなく“枠全体の残り”で判断する。
 *
 * 使い方:
 *   npm run line-usage:dev            # 今月(JST)
 *   npm run line-usage:prod 2026-07   # 月を指定
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECTS = { dev: 'groomhaus-dev', prod: 'groomhaus-prod' };
const PLAN_INCLUDED = 30_000; // スタンダードプランに含まれる通数
const OVERAGE_YEN = 3; // 超過1通あたり(2026-10改定後も20万通までは同額)

const env = process.argv[2];
const projectId = PROJECTS[env];
if (!projectId) {
  console.error('使い方: node functions/line-usage.mjs <dev|prod> [YYYY-MM]');
  process.exit(1);
}

const month =
  process.argv[3] ??
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date()).slice(0, 7);

initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore();

const KINDS = [
  ['kind_confirmation', '予約確定'],
  ['kind_reminder', 'リマインド'],
  ['kind_cancel', 'キャンセル'],
  ['kind_reschedule', '日時変更'],
  ['kind_manual', '個別'],
];

const tenants = await db.collection('tenants').get();

// テナント数は多くないので素直に1件ずつ引く（コレクショングループ索引を増やさない）
const rows = await Promise.all(
  tenants.docs.map(async (t) => {
    const snap = await t.ref.collection('lineUsage').doc(month).get();
    const u = snap.data() ?? {};
    const num = (k) => Number(u[k] ?? 0);
    return {
      id: t.id,
      name: t.get('name') ?? t.id,
      // 専用OAを持つ店は自分で払うので、枠の判断からは外す
      ownOa: !!t.get('lineConfig.messagingChannelAccessToken'),
      shared: num('channel_shared'),
      own: num('channel_tenant'),
      total: num('total'),
      kinds: Object.fromEntries(KINDS.map(([k, label]) => [label, num(k)])),
    };
  }),
);

rows.sort((a, b) => b.shared - a.shared || b.total - a.total);

const sharedTotal = rows.reduce((s, r) => s + r.shared, 0);
const pct = ((sharedTotal / PLAN_INCLUDED) * 100).toFixed(1);

console.log(`\n■ LINE送信 ${month}  (${projectId})\n`);
console.log('  店舗                    OA        共有    専用    合計   内訳');
console.log('  ' + '-'.repeat(76));
for (const r of rows) {
  const detail =
    Object.entries(r.kinds)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}${v}`)
      .join(' ') || '-';
  console.log(
    '  ' +
      String(r.name).padEnd(22, ' ').slice(0, 22) +
      (r.ownOa ? '専用  ' : '共有  ').padEnd(8) +
      String(r.shared).padStart(6) +
      String(r.own).padStart(8) +
      String(r.total).padStart(8) +
      '   ' +
      detail,
  );
}

console.log('\n■ 共有OAの枠');
if (sharedTotal === 0) {
  console.log('  共有OAからの送信はありません（全店が専用OA）。費用の心配は不要です。\n');
} else {
  const over = Math.max(0, sharedTotal - PLAN_INCLUDED);
  console.log(`  ${sharedTotal.toLocaleString()} / ${PLAN_INCLUDED.toLocaleString()} 通  (${pct}%)`);
  if (over > 0) {
    console.log(`  🔴 超過 ${over.toLocaleString()} 通 = 約 ${(over * OVERAGE_YEN).toLocaleString()} 円/月`);
    const top = rows.filter((r) => !r.ownOa && r.shared > 0).slice(0, 3);
    if (top.length) {
      console.log('     → 専用OAへの誘導候補:');
      for (const r of top) {
        console.log(`        ${r.name}  ${r.shared.toLocaleString()}通 (全体の${((r.shared / sharedTotal) * 100).toFixed(0)}%)`);
      }
    }
  } else if (sharedTotal >= PLAN_INCLUDED * 0.8) {
    console.log(`  ⚠ 枠の80%を超えています。残り ${(PLAN_INCLUDED - sharedTotal).toLocaleString()} 通。`);
    console.log('     上位の店から専用OAへ誘導すると、超過(1通3円)に入らずに済みます。');
  } else {
    console.log(`  余裕あり。残り ${(PLAN_INCLUDED - sharedTotal).toLocaleString()} 通。`);
    console.log('  ※ 枠内は1通あたりの追加費用が0円なので、今は無理に誘導しなくてよい。');
  }
  console.log('');
}
