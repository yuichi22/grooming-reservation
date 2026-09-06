// 料金表（犬種×サービス）とオプションを投入するシード。
// 既定はローカルエミュレータ。実DBに入れる場合は FIRESTORE_EMULATOR_HOST を外し
// GOOGLE_APPLICATION_CREDENTIALS と PROJECT を指定して実行する。
//   ローカル: node seed-menu.mjs
// ※ 犬種/サービス/オプション/料金表を一度クリアして作り直す（破壊的）。顧客・犬・予約は触らない。
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!process.env.FIRESTORE_EMULATOR_HOST && !process.env.SEED_REAL) {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
}
const PROJECT = process.env.PROJECT || 'demo-groomhaus';
const TENANT = process.env.TENANT || 'groomhaus';

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const base = db.collection('tenants').doc(TENANT);

// 所要時間は画像に無いため仮置き（あとで料金表/オプションで調整）
const DUR_SHAMPOO = 60;
const DUR_SHAMPOO_CUT = 90;

// [犬種名, シャンプー, シャンプー・カット(無ければ null)]
const ROWS = [
  ['チワワ スムース', 3500, null],
  ['チワワ ロング', 4000, 5500],
  ['ダックスフンド スムース', 4000, null],
  ['ダックスフンド ロング', 4500, 5800],
  ['マルチーズ', 4800, 6000],
  ['ヨークシャーテリア', 4800, 6000],
  ['シーズー', 5300, 7000],
  ['トイプードル', 5300, 7000],
  ['ミニチュアシュナウザー', 5300, 7000],
  ['ビションフリーゼ', 5500, 7800],
  ['ポメラニアン', 4800, 5800],
  ['パピヨン', 4500, 5800],
  ['ペキニーズ', 5000, 6500],
  ['柴犬', 6000, null],
  ['コーギー', 6200, null],
  ['日本スピッツ', 6000, null],
  ['パグ', 4500, null],
  ['ボストンテリア', 4500, null],
  ['イタリアングレーハウンド', 4000, null],
  ['ミニチュアピンシャー', 4000, null],
  ['フレンチブルドッグ', 5000, null],
  ['ビーグル', 5500, null],
  ['キャバリア', 5500, 6800],
  ['コッカースパニエル', 6800, 8800],
  ['ジャックラッセルテリア', 4800, 6500],
  ['シェルティ', 6800, null],
  ['ウエストハイランドホワイトテリア', 5500, 6800],
  ['ワイヤーフォックステリア', 5500, 7000],
];

// [オプション名, 料金, 仮の所要時間(分)]
const OPTIONS = [
  ['爪切り', 500, 10],
  ['足裏バリカン', 500, 10],
  ['足まわりカット', 500, 10],
  ['耳掃除(毛抜きなし)', 500, 10],
  ['耳掃除(毛抜きあり)', 1000, 15],
  ['ヒゲカット', 500, 10],
  ['お腹バリカン', 500, 10],
  ['肛門腺絞り', 500, 5],
  ['毛玉取り', 500, 15],
  ['抜け毛取り', 500, 15],
  ['足先バリカン(プー足)', 1000, 15],
  ['部分カット', 500, 10],
  ['歯磨き', 500, 10],
  ['肉球クリーム(マッサージ付き)', 500, 10],
  ['トリートメント', 500, 15],
  ['クレンジング', 500, 10],
  ['ハーブパック', 1800, 30],
  ['ましゅまろはちみつ泡パック', 1000, 20],
  ['オールシザー仕上げ', 1000, 30],
  ['デザインカット', 500, 20],
];

async function clearCol(name) {
  const snap = await base.collection(name).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
  return snap.size;
}

console.log(`project=${PROJECT} tenant=${TENANT} emulator=${process.env.FIRESTORE_EMULATOR_HOST ?? '(real DB)'}`);

// 1) クリア
for (const c of ['pricing', 'breeds', 'services', 'options']) {
  const n = await clearCol(c);
  console.log(`cleared ${c}: ${n}`);
}

// 2) サービス
const shampoo = await base.collection('services').add({ name: 'シャンプー', active: true });
const shampooCut = await base.collection('services').add({ name: 'シャンプー・カット', active: true });
console.log('services: シャンプー, シャンプー・カット');

// 3) 犬種（画像の並び順）
const breedIdByName = {};
for (let i = 0; i < ROWS.length; i++) {
  const name = ROWS[i][0];
  const ref = await base.collection('breeds').add({ name, active: true, order: i });
  breedIdByName[name] = ref.id;
}
console.log(`breeds: ${ROWS.length}`);

// 4) 料金表セル
let order = 0;
let cells = 0;
for (const [name, shampooPrice, cutPrice] of ROWS) {
  const breedId = breedIdByName[name];
  const mk = async (serviceId, price, durationMin) => {
    await base.collection('pricing').doc(`${breedId}__${serviceId}`).set({
      breedId,
      serviceId,
      price,
      durationMin,
      active: true,
      order: order++,
    });
    cells++;
  };
  await mk(shampoo.id, shampooPrice, DUR_SHAMPOO);
  if (cutPrice != null) await mk(shampooCut.id, cutPrice, DUR_SHAMPOO_CUT);
}
console.log(`pricing cells: ${cells}`);

// 5) オプション
for (const [name, price, durationMin] of OPTIONS) {
  await base.collection('options').add({ name, price, durationMin, active: true });
}
console.log(`options: ${OPTIONS.length}`);

// 6) テスト犬パーこの犬種を新しい「チワワ ロング」に付け替え、孤立したオプション調整をクリア
const pako = base.collection('dogs').doc('rWNcoClS6nHvIoULK5fz');
if ((await pako.get()).exists) {
  await pako.update({ breedId: breedIdByName['チワワ ロング'], optionAdjustments: {} });
  console.log('repointed パーこ.breedId → チワワ ロング, cleared optionAdjustments');
}

console.log('done.');
