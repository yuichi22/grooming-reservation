/// <reference types="vitest" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// index.html に Cloud Functions(asia-northeast1)への preconnect を差し込む。
// LINE から開いた予約画面は JS の取得後すぐ callable を呼ぶので、その接続を先に済ませておく。
// プロジェクトIDが無い（.env 未設定・エミュレータ）ときは何もしない。
function preconnectFunctions(projectId: string | undefined): Plugin {
  return {
    name: 'preconnect-functions',
    transformIndexHtml() {
      if (!projectId) return [];
      return [
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: `https://asia-northeast1-${projectId}.cloudfunctions.net`, crossorigin: '' },
          injectTo: 'head',
        },
      ];
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react(), preconnectFunctions(env.VITE_FIREBASE_PROJECT_ID)],
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    },
  };
});
