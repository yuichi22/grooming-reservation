import { initializeApp } from 'firebase/app';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';

const useEmulators = import.meta.env.VITE_USE_EMULATORS === 'true';

// dev / prod は .env (VITE_*) で切り替える (§12)。
// エミュレータ利用時は最小のダミー config で良い。
// 注: ここでは Functions のみ初期化。Auth/Firestore は staff 側でのみ使うため
//     firebaseStaff.ts に分離し、顧客向け /book バンドルに混ぜない（バンドル削減 A）。
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? 'demo-key',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'demo-groomhaus',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);
// 関数は東京リージョン（サーバ側 setGlobalOptions と一致させる）。
export const functions = getFunctions(app, 'asia-northeast1');

if (useEmulators) {
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}
