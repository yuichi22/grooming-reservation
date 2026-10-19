// prod デプロイの門番。firebase.json の hosting.predeploy / functions.predeploy から呼ばれる。
//   node scripts/guard-prod-deploy.mjs            … Hosting 用
//   node scripts/guard-prod-deploy.mjs functions  … Functions 用(②の未コミット検査の対象が functions/ になる)
//
// 背景: mobile-order-app で作業ブランチから deploy:prod を叩き、ブランチHEAD全体(未承認コミットやWIP)が
// 本番公開される事故があった(2026-09-05)。「prodはmainから」は口伝では全セッションに届かないため、
// デプロイ経路そのもので機械的に止める(mobile-order-app / suomi-admin と同じ仕組み)。
//
// 緊急時の迂回: AKUTO_FORCE_PROD_DEPLOY=1 npm run deploy:prod
import { execSync } from 'node:child_process';

const PROD_PROJECT = 'groomhaus-prod';
const project = process.env.GCLOUD_PROJECT || '';
const target = process.argv[2] === 'functions' ? 'functions' : 'hosting';
const label = target === 'functions' ? 'functions' : 'Hosting';

// dev やエミュレータは素通し。プロジェクトが特定できない場合は安全側(prod扱い)に倒す。
if (project && project !== PROD_PROJECT) process.exit(0);

if (process.env.AKUTO_FORCE_PROD_DEPLOY === '1') {
  console.warn('⚠ AKUTO_FORCE_PROD_DEPLOY=1 により prod デプロイ保護を迂回します。');
  process.exit(0);
}

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const fail = (lines) => {
  console.error(`\n🛑 prod の ${label} デプロイを中止しました。`);
  lines.forEach((l) => console.error('   ' + l));
  console.error('   (緊急時のみ AKUTO_FORCE_PROD_DEPLOY=1 で迂回可)\n');
  process.exit(1);
};

// ① prod は main からのみ出す
const branch = sh('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') {
  fail([
    `現在のブランチは "${branch}" です。prod は必ず main から出します。`,
    '作業ブランチのHEAD全体(未承認コミット/WIP)が本番公開されるのを防ぐためです。',
    'main にマージしてから main 上で deploy:prod してください。'
  ]);
}

// ② デプロイに載るファイルに未コミット変更があれば止める(WIP巻き込み防止)。
//    Functions は --only functions:名前 でも functions/ 全体がアップロードされるため functions/ を検査する。
//    .env は gitignore なのでここには出ない。
const dirtyPaths = target === 'functions' ? 'functions' : 'src public index.html vite.config.ts tsconfig.json package.json package-lock.json';
const dirty = sh(`git status --porcelain -- ${dirtyPaths}`);
if (dirty) {
  fail([
    `${label} デプロイに載るファイルに未コミットの変更があります:`,
    ...dirty.split('\n').slice(0, 10).map((l) => '  ' + l),
    'コミットするか退避してから deploy:prod してください(ビルドは作業ツリーの内容で作られます)。'
  ]);
}

// ③ ローカル main が origin/main より古ければ止める(巻き戻し配信防止)。
//    fetch はしない(オフラインでも動くよう、手元が知っている origin/main とだけ比較)。
try {
  const behind = Number(sh('git rev-list --count HEAD..origin/main'));
  if (behind > 0) {
    fail([
      `ローカル main が origin/main より ${behind} コミット遅れています。`,
      'git pull してから deploy:prod してください(古いビルドで本番を巻き戻すのを防ぐため)。'
    ]);
  }
} catch {
  // origin/main が無い環境では比較しない
}

console.log(`✅ prod ${label} デプロイ保護: main / クリーン / origin と同期済み (${sh('git rev-parse --short HEAD')})`);
