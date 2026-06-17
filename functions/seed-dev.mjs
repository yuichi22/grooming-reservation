// dev 初期データ投入（実 groomhaus-dev に対して Admin SDK で実行）。
// 実行: GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node functions/seed-dev.mjs
// 注意: エミュレータ用の *_EMULATOR_HOST は設定しないこと（実プロジェクトに書く）。
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { readFileSync } from 'node:fs';

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const sa = JSON.parse(readFileSync(keyPath, 'utf8'));
initializeApp({ credential: cert(sa), projectId: sa.project_id });

const db = getFirestore();
const auth = getAuth();
const TENANT = 'groomhaus';
const PW = process.env.SEED_PASSWORD;
if (!PW) {
  console.error('SEED_PASSWORD env var is required (dev 用パスワード)');
  process.exit(1);
}

async function ensureUser(email, claims) {
  let user;
  try {
    user = await auth.createUser({ email, password: PW });
    console.log(`  created ${email} (${user.uid})`);
  } catch (e) {
    if (e.code === 'auth/email-already-exists') {
      user = await auth.getUserByEmail(email);
      console.log(`  exists  ${email} (${user.uid})`);
    } else throw e;
  }
  await auth.setCustomUserClaims(user.uid, claims);
  return user.uid;
}

async function main() {
  console.log('# users + claims');
  const superUid = await ensureUser('super@groomhaus.dev', { superAdmin: true });
  const adminUid = await ensureUser('admin@groomhaus.dev', { tenantId: TENANT, role: 'admin' });
  const trimmerUid = await ensureUser('trimmer@groomhaus.dev', { tenantId: TENANT, role: 'trimmer' });

  console.log('# tenant');
  const base = db.collection('tenants').doc(TENANT);
  await base.set(
    {
      name: 'GROOM HAUS',
      plan: 'standard',
      status: 'active',
      lineConfig: { providerId: '', miniAppChannelId: '', messagingApiChannelId: '', liffId: '' },
      settings: {
        timezone: 'Asia/Tokyo',
        businessHours: [{ start: '09:00', end: '19:00' }],
        bufferMin: 10,
        workTimeOptions: [50, 80, 110],
        cancelDeadlineHours: 24,
      },
      createdAt: new Date().toISOString(),
    },
    { merge: true },
  );

  console.log('# staff');
  await base.collection('staff').doc(adminUid).set({ name: '管理者', role: 'admin', active: true, firebaseUid: adminUid });
  await base.collection('staff').doc(trimmerUid).set({ name: '担当トリマー', role: 'trimmer', active: true, firebaseUid: trimmerUid });

  console.log('# menus');
  await base.collection('menus').doc('trim').set({ name: 'カット', defaultDurationMin: 80, fixedDuration: false, price: 5500, active: true });
  await base.collection('menus').doc('shampoo').set({ name: 'シャンプー', defaultDurationMin: 50, fixedDuration: true, price: 3300, active: true });

  console.log('\n=== SEED DONE ===');
  console.log(`super:   super@groomhaus.dev / ${PW}  (uid ${superUid})`);
  console.log(`admin:   admin@groomhaus.dev / ${PW}  (uid ${adminUid})`);
  console.log(`trimmer: trimmer@groomhaus.dev / ${PW} (uid ${trimmerUid})`);
}

main().catch((e) => { console.error('SEED ERROR:', e); process.exit(1); });
