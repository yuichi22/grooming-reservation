// スタッフ向けの Auth / Firestore 初期化。staff チャンクからのみ import する
// （顧客向け /book バンドルに firebase/auth・firebase/firestore を載せないため A）。
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { app } from './firebase';

const useEmulators = import.meta.env.VITE_USE_EMULATORS === 'true';

export const auth = getAuth(app);
export const db = getFirestore(app);

if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}
