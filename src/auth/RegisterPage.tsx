// 管理者セルフ登録ページ（POSの /register と同方式）。
// ポータルの「管理者登録URL」(?tenant=…&invite=…) から開き、本人がメール・氏名・
// パスワードを決めて登録する。成功後はそのままログインして管理画面へ。
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import { useAuth } from './AuthContext';

const registerGroomAdmin = httpsCallable<
  { tenantId: string; inviteCode: string; email: string; name: string; password: string },
  { ok: boolean; email: string }
>(functions, 'registerGroomAdmin');

export default function RegisterPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const tenantId = params.get('tenant') ?? '';
  const inviteCode = params.get('invite') ?? '';

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const invalidLink = !tenantId || !inviteCode;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await registerGroomAdmin({ tenantId, inviteCode, email, name, password });
      // 登録した認証情報でそのままログイン
      await login(email, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登録に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-card">
      <h1>管理者アカウント登録</h1>
      <p className="muted">
        この店舗（{tenantId || '不明'}）を管理するアカウントを作成します。登録後そのまま管理画面が開きます。
      </p>
      {invalidLink ? (
        <p className="error">登録リンクが不完全です。ポータルに表示されているURLをそのまま開いてください。</p>
      ) : (
        <form onSubmit={onSubmit}>
          <label>
            お名前
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="氏名を入力" required />
          </label>
          <label>
            メールアドレス
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com" required />
          </label>
          <label>
            パスワード
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="6文字以上で入力"
              required
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? '登録中…' : 'アカウントを登録'}
          </button>
        </form>
      )}
      <p className="muted" style={{ marginTop: 16 }}>
        <Link to="/login">ログイン画面へ戻る</Link>
      </p>
    </div>
  );
}
