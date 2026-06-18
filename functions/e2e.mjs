// E2E: エミュレータ上で予約フロー全体を通す (§3/§6/§7/§8/§9/§10)。
// 実行前提: firebase emulators(auth,firestore,functions) が起動済み。
//   FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST は本スクリプトで設定。
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

const PROJECT = 'demo-groomhaus';
const FN = `http://127.0.0.1:5001/${PROJECT}/asia-northeast1`;
const AUTH = `http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts`;
const TENANT = 'groomhaus';
const DATE = '2026-06-20';

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const auth = getAuth();

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}  ${detail}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function call(name, data, idToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(`${FN}/${name}`, { method: 'POST', headers, body: JSON.stringify({ data }) });
  const json = await res.json();
  if (json.error) throw new Error(`${name} -> ${JSON.stringify(json.error)}`);
  return json.result;
}

async function seed() {
  console.log('# seed');
  // 各実行をクリーンにするためテナント配下を全削除して作り直す
  await db.recursiveDelete(db.collection('tenants').doc(TENANT));
  try {
    await auth.createUser({ uid: 'admin1', email: 'admin@example.com', password: 'password123' });
  } catch {
    /* already exists */
  }
  await auth.setCustomUserClaims('admin1', { tenantId: TENANT, role: 'admin' });

  const base = db.collection('tenants').doc(TENANT);
  await base.set({
    name: 'GROOM HAUS',
    plan: 'standard',
    status: 'active',
    lineConfig: { providerId: '', miniAppChannelId: '', messagingApiChannelId: '', liffId: '' },
    settings: {
      timezone: 'Asia/Tokyo',
      businessHours: [{ start: '09:00', end: '13:00' }], // §6 の例を再現
      bufferMin: 10,
      workTimeOptions: [50, 80, 110],
    },
    createdAt: new Date().toISOString(),
  });
  await base.collection('menus').doc('trim').set({ name: 'カット', defaultDurationMin: 80, fixedDuration: false, price: 5500, active: true });
  await base.collection('menus').doc('shampoo').set({ name: 'シャンプー', defaultDurationMin: 50, fixedDuration: true, price: 3300, active: true });
  await base.collection('staff').doc('trimmer1').set({ name: '担当A', role: 'trimmer', active: true, firebaseUid: 'trimmer1' });
  // admin は施術しない想定 → active:false（予約割当の対象外）。§6 例は単一リソース前提。
  await base.collection('staff').doc('admin1').set({ name: '管理者', role: 'admin', active: false, firebaseUid: 'admin1' });
  // §6 の例: 9:00-10:00 と 11:00-13:00 を trimmer1 に予約済みとして投入
  await base.collection('bookings').doc('seed1').set({ dogId: 'x', customerId: 'x', menuId: 'trim', staffId: 'trimmer1', date: DATE, startTime: '09:00', durationMin: 50, bufferMin: 10, slotEnd: '10:00', status: 'reserved', createdAt: new Date().toISOString() });
  await base.collection('bookings').doc('seed2').set({ dogId: 'x', customerId: 'x', menuId: 'trim', staffId: 'trimmer1', date: DATE, startTime: '11:00', durationMin: 110, bufferMin: 10, slotEnd: '13:00', status: 'reserved', createdAt: new Date().toISOString() });
  console.log('  seeded');
}

async function adminIdToken() {
  const res = await fetch(`${AUTH}:signInWithPassword?key=fake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'password123', returnSecureToken: true }),
  });
  const json = await res.json();
  if (!json.idToken) throw new Error(`signIn failed: ${JSON.stringify(json)}`);
  return json.idToken;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await seed();
  const token = 'dev:Ualice'; // LIFF dev トークン（lineUserId=Ualice）

  console.log('\n# §3 customerSession / find-or-link');
  const s1 = await call('customerSession', { tenantId: TENANT, accessToken: token });
  check('初回は電話番号が必要 (needsPhone)', s1.needsPhone === true, JSON.stringify(s1));
  const s2 = await call('customerSession', { tenantId: TENANT, accessToken: token, phone: '09011112222', ownerName: 'Alice' });
  check('同一 lineUserId は同じ customerId (新規作成しない)', s2.customerId === s1.customerId, `${s1.customerId} vs ${s2.customerId}`);
  check('電話番号リンク後は needsPhone=false', s2.needsPhone === false);
  const customerId = s2.customerId;

  console.log('\n# 犬の登録 (§7 初回 confirmedDurationMin=null)');
  const dog = await call('registerDog', { tenantId: TENANT, accessToken: token, customerId, name: 'ポチ', breed: 'トイプー' });
  const dogId = dog.dogId;
  check('dogId が返る', typeof dogId === 'string' && dogId.length > 0);

  console.log('\n# §6 空きスロット (営業9-13/buffer10, 予約済9-10・11-13 → 空きは10-11)');
  const avTrim = await call('getAvailability', { tenantId: TENANT, accessToken: token, date: DATE, menuId: 'trim', dogId });
  check('80分(need90)は出ない', eq(avTrim.slots, []), `slots=${JSON.stringify(avTrim.slots)} duration=${avTrim.durationMin}`);
  check('  duration=80 (confirmed=null→menu標準)', avTrim.durationMin === 80);
  const avSham = await call('getAvailability', { tenantId: TENANT, accessToken: token, date: DATE, menuId: 'shampoo', dogId });
  check('シャンプー50分固定は10:00が出る', eq(avSham.slots, ['10:00']), `slots=${JSON.stringify(avSham.slots)}`);
  check('  duration=50 (固定)', avSham.durationMin === 50);

  // 50分の犬で trim → need60 → 10:00 が出る ("50分は出る")
  await db.collection('tenants').doc(TENANT).collection('dogs').doc(dogId).update({ confirmedDurationMin: 50 });
  const avTrim50 = await call('getAvailability', { tenantId: TENANT, accessToken: token, date: DATE, menuId: 'trim', dogId });
  check('50分(need60)は10:00が出る', eq(avTrim50.slots, ['10:00']), `slots=${JSON.stringify(avTrim50.slots)} duration=${avTrim50.durationMin}`);
  // 次の検証のため confirmed を戻す
  await db.collection('tenants').doc(TENANT).collection('dogs').doc(dogId).update({ confirmedDurationMin: null });

  console.log('\n# §8 予約確定 (指名なし→空きスタッフ割当) / §6 サーバ再検証');
  const bk = await call('createBooking', { tenantId: TENANT, accessToken: token, customerId, dogId, menuId: 'shampoo', date: DATE, startTime: '10:00' });
  check('スタッフが自動割当 (trimmer1)', bk.staffId === 'trimmer1', `staffId=${bk.staffId}`);
  check('slotEnd=11:00 (10:00+50+10)', bk.slotEnd === '11:00', `slotEnd=${bk.slotEnd}`);
  const bookingId = bk.bookingId;
  const bkSnap = await db.collection('tenants').doc(TENANT).collection('bookings').doc(bookingId).get();
  check('予約が reserved で作成される', bkSnap.data()?.status === 'reserved');

  // 空き済みになったか: 同じ10:00をもう一度取ると消える
  const avAfter = await call('getAvailability', { tenantId: TENANT, accessToken: token, date: DATE, menuId: 'shampoo', dogId });
  check('予約後は10:00が空きから消える', eq(avAfter.slots, []), `slots=${JSON.stringify(avAfter.slots)}`);

  console.log('\n# §7 施術完了 (staff 認証, トランザクション)');
  const idToken = await adminIdToken();
  await call('completeBooking', { tenantId: TENANT, bookingId, finalDurationMin: 55, finalPrice: 3500 }, idToken);
  const doneSnap = await db.collection('tenants').doc(TENANT).collection('bookings').doc(bookingId).get();
  check('booking が done に', doneSnap.data()?.status === 'done');
  check('finalPrice 確定', doneSnap.data()?.finalPrice === 3500);
  const recSnap = await db.collection('tenants').doc(TENANT).collection('dogs').doc(dogId).collection('records').doc(bookingId).get();
  check('records に追記 (id=bookingId)', recSnap.exists && recSnap.data()?.price === 3500);
  const dogSnap = await db.collection('tenants').doc(TENANT).collection('dogs').doc(dogId).get();
  check('dog.confirmedDurationMin=55 に更新 (§7 次回自動適用)', dogSnap.data()?.confirmedDurationMin === 55);

  console.log('\n# §10 台帳イベント (onBookingDone トリガ → pointEvents 冪等生成)');
  let ev = null;
  for (let i = 0; i < 20; i++) {
    const evSnap = await db.collection('tenants').doc(TENANT).collection('pointEvents').doc(bookingId).get();
    if (evSnap.exists) { ev = evSnap.data(); break; }
    await sleep(500);
  }
  check('pointEvents/{bookingId} が生成される', ev != null);
  if (ev) {
    check('  type=trimming', ev.type === 'trimming');
    check('  amount=3500', ev.amount === 3500);
    check('  brand=GROOM HAUS', ev.brand === 'GROOM HAUS');
    check('  lineUserId=Ualice (memberId 未連携でも解決可)', ev.lineUserId === 'Ualice');
    check('  memberId=null (CRM 未連携)', ev.memberId === null);
    check('  status=pending (CRM_WEBHOOK_URL 未設定で貯まる)', ev.status === 'pending');
  }

  console.log('\n# §9 リマインド (sendRemindersNow, admin 認証)');
  const rem = await call('sendRemindersNow', { tenantId: TENANT, date: DATE }, idToken);
  check('リマインド処理が実行され件数を返す', typeof rem.sent === 'number' && typeof rem.skipped === 'number', JSON.stringify(rem));
  console.log(`    → sent=${rem.sent}, skipped=${rem.skipped} (LINEトークン未設定のため送信はskip)`);

  console.log('\n# §11 営業時間の例外（休業日）');
  const CLOSED = '2026-06-25';
  await db.collection('tenants').doc(TENANT).collection('closures').doc(CLOSED).set({ reason: '臨時休業', fullDay: true });
  const avClosed = await call('getAvailability', { tenantId: TENANT, accessToken: token, date: CLOSED, menuId: 'shampoo', dogId });
  check('休業日は closed=true で空きなし', avClosed.closed === true && eq(avClosed.slots, []), JSON.stringify(avClosed));
  let closedBookingRejected = false;
  try {
    await call('createBooking', { tenantId: TENANT, accessToken: token, customerId, dogId, menuId: 'shampoo', date: CLOSED, startTime: '09:00' });
  } catch {
    closedBookingRejected = true;
  }
  check('休業日は予約も拒否される', closedBookingRejected);

  console.log('\n# §11 キャンセル（締切前は顧客が取消可）');
  const FREE = '2026-06-24'; // 空き日（十分先＝締切前）
  const bk2 = await call('createBooking', { tenantId: TENANT, accessToken: token, customerId, dogId, menuId: 'shampoo', date: FREE, startTime: '09:00' });
  const cancelRes = await call('cancelBookingByCustomer', { tenantId: TENANT, accessToken: token, bookingId: bk2.bookingId });
  check('顧客キャンセルで status=canceled', cancelRes.status === 'canceled');
  const avFree = await call('getAvailability', { tenantId: TENANT, accessToken: token, date: FREE, menuId: 'shampoo', dogId });
  check('キャンセル後は 09:00 が空きに戻る', avFree.slots.includes('09:00'), JSON.stringify(avFree.slots));

  console.log('\n# §11 手動マージ（重複顧客の統合）');
  const bob = await call('customerSession', { tenantId: TENANT, accessToken: 'dev:Ubob', phone: '09022223333', ownerName: 'Bob' });
  const bobDog = await call('registerDog', { tenantId: TENANT, accessToken: 'dev:Ubob', customerId: bob.customerId, name: 'ハチ' });
  const mg = await call('mergeCustomers', { tenantId: TENANT, sourceCustomerId: bob.customerId, targetCustomerId: customerId }, idToken);
  check('犬1頭が統合先へ移動', mg.movedDogs === 1, JSON.stringify(mg));
  const movedDog = await db.collection('tenants').doc(TENANT).collection('dogs').doc(bobDog.dogId).get();
  check('ハチの customerId が統合先に', movedDog.data()?.customerId === customerId);
  const bobAfter = await db.collection('tenants').doc(TENANT).collection('customers').doc(bob.customerId).get();
  check('統合元に mergedInto が記録される', bobAfter.data()?.mergedInto === customerId);

  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E ERROR:', e);
  process.exit(1);
});
