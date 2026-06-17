// dev: tenants/groomhaus.lineConfig に Messaging/LIFF 設定を投入し、
// 予約中(reserved)の予約と対象顧客の lineUserId 有無を一覧する。
// 値は env: MESSAGING_TOKEN, MESSAGING_CHANNEL_ID, MINIAPP_CHANNEL_ID, LIFF_ID
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

const sa = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
initializeApp({ credential: cert(sa), projectId: sa.project_id });
const db = getFirestore();
const base = db.collection('tenants').doc('groomhaus');

const patch = {};
if (process.env.MESSAGING_TOKEN) patch['lineConfig.messagingChannelAccessToken'] = process.env.MESSAGING_TOKEN;
if (process.env.MESSAGING_CHANNEL_ID) patch['lineConfig.messagingApiChannelId'] = process.env.MESSAGING_CHANNEL_ID;
if (process.env.MINIAPP_CHANNEL_ID) patch['lineConfig.miniAppChannelId'] = process.env.MINIAPP_CHANNEL_ID;
if (process.env.LIFF_ID) patch['lineConfig.liffId'] = process.env.LIFF_ID;

if (Object.keys(patch).length) {
  await base.update(patch);
  console.log('lineConfig updated:', Object.keys(patch).join(', '));
}

const bookings = await base.collection('bookings').where('status', '==', 'reserved').get();
console.log(`\nreserved bookings: ${bookings.size}`);
for (const b of bookings.docs) {
  const d = b.data();
  const cust = (await base.collection('customers').doc(d.customerId).get()).data() || {};
  console.log(`  ${d.date} ${d.startTime}-${d.slotEnd} dog=${d.dogId} lineUserId=${cust.lineUserId ? 'YES' : 'no'}`);
  // テスト用: リマインド送信済みフラグをクリア（RESET_REMINDERS=1 のとき）
  if (process.env.RESET_REMINDERS) await b.ref.update({ reminderSentAt: FieldValue.delete() });
}
if (process.env.RESET_REMINDERS) console.log('  (reminderSentAt cleared)');
