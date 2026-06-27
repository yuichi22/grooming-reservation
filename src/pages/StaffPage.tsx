import { useState, type FormEvent } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { sendPasswordResetEmail } from 'firebase/auth';
import { useAuth } from '../auth/AuthContext';
import { auth } from '../firebaseStaff';
import { staffCol } from '../lib/firestore';
import { inviteStaff } from '../lib/functions';
import { useCollection } from '../lib/useCollection';
import type { Staff, StaffRole } from '../lib/types';

export default function StaffPage() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId;
  if (!tenantId) return <p className="error">テナントが割り当てられていません。</p>;
  return <StaffInner tenantId={tenantId} />;
}

function StaffInner({ tenantId }: { tenantId: string }) {
  const { data: staff, loading } = useCollection<Staff>(staffCol(tenantId), [tenantId]);

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<StaffRole>('trimmer');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      // メール招待: Authユーザー用意＋custom claims付与＋staff作成 (§2)
      const res = await inviteStaff({ tenantId, email: email.trim(), name: name.trim(), role });
      // 新規ユーザーにはパスワード設定メールを送る（Firebase標準メール）
      if (res.data.created) {
        await sendPasswordResetEmail(auth, res.data.email);
        setMsg(`招待しました: ${name}（${role}）。パスワード設定メールを ${res.data.email} に送信しました。`);
      } else {
        setMsg(`権限を付与しました: ${name}（${role}）。${res.data.email} は既存ユーザーのため既存のパスワードでログインできます。`);
      }
      setEmail('');
      setName('');
    } catch (err) {
      const m = err instanceof Error ? err.message : '';
      setMsg(
        /another tenant/.test(m)
          ? 'このメールは別の店舗で使われています。'
          : m || '招待に失敗しました',
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(s: Staff) {
    await updateDoc(doc(staffCol(tenantId), s.id), { active: !s.active });
  }

  return (
    <section>
      <h1>スタッフ</h1>
      <p className="muted">
        氏名・メール・ロールを入力して招待します。初めての方にはパスワード設定メールが届き、設定後にログインできます。
        ロールが「admin（管理者）」のスタッフは予約枠には入りません。
      </p>
      <form className="row-form" onSubmit={onInvite}>
        <input
          type="email"
          placeholder="メールアドレス"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input placeholder="氏名" value={name} onChange={(e) => setName(e.target.value)} required />
        <select value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
          <option value="trimmer">trimmer（トリマー）</option>
          <option value="admin">admin（管理者）</option>
        </select>
        <button type="submit" disabled={busy}>
          {busy ? '招待中…' : '招待する'}
        </button>
      </form>
      {msg && <p className="muted">{msg}</p>}

      {loading ? (
        <p>読み込み中…</p>
      ) : (
        <div className="table-wrap"><table>
          <thead>
            <tr>
              <th>氏名</th>
              <th>role</th>
              <th>メール</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.role}</td>
                <td>{s.email ?? '—'}</td>
                <td>{s.active ? '在籍' : '停止'}</td>
                <td>
                  <button onClick={() => toggleActive(s)}>{s.active ? '停止' : '復帰'}</button>
                </td>
              </tr>
            ))}
            {staff.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  スタッフ未登録
                </td>
              </tr>
            )}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
