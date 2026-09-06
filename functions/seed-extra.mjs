// ローカル(エミュレータ)に犬種・料金表のサンプルを追加して 2 列レイアウトを確認しやすくする。
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
initializeApp({ projectId: 'demo-groomhaus' });
const db = getFirestore();
const base = db.collection('tenants').doc('groomhaus');
for (const [id, name] of [['toy', 'トイプードル'], ['shiba', '柴犬'], ['chihuahua', 'チワワ']]) {
  await base.collection('breeds').doc(id).set({ name, active: true });
}
const cells = [
  ['toy', 'cut', 6000, 90, 0], ['toy', 'sham', 3500, 50, 1],
  ['shiba', 'cut', 7000, 110, 0], ['shiba', 'sham', 3800, 60, 1],
  ['chihuahua', 'cut', 5000, 70, 0],
];
for (const [b, s, price, durationMin, order] of cells) {
  await base.collection('pricing').doc(`${b}__${s}`).set({ breedId: b, serviceId: s, price, durationMin, active: true, order });
}
console.log('added breeds + pricing');
