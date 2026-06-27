import { useState, type FormEvent } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { sendPasswordResetEmail } from 'firebase/auth';
import { useAuth } from '../auth/AuthContext';
import { auth } from '../firebaseStaff';
import { staffCol } from '../lib/firestore';
import { getStaffInviteLink, inviteStaff, updateStaff } from '../lib/functions';
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
  // パスワード設定リンク（メール不達時の共有用）
  const [inviteLink, setInviteLink] = useState<{ name: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* クリップボード不可の環境は手動コピー */
    }
  }

  async function showInviteLink(s: Staff) {
    setMsg(null);
    try {
      const res = await getStaffInviteLink({ tenantId, targetUid: s.id });
      setInviteLink({ name: s.name, link: res.data.link });
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'リンクの発行に失敗しました');
    }
  }

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setInviteLink(null);
    setBusy(true);
    try {
      // メール招待: Authユーザー用意＋custom claims付与＋staff作成 (§2)
      const res = await inviteStaff({ tenantId, email: email.trim(), name: name.trim(), role });
      // 新規ユーザーにはパスワード設定メールを送る（Firebase標準メール）
      if (res.data.created) {
        await sendPasswordResetEmail(auth, res.data.email);
        setMsg(`招待しました: ${name}（${role}）。パスワード設定メールを ${res.data.email} に送信しました。`);
        if (res.data.resetLink) setInviteLink({ name, link: res.data.resetLink });
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

  // 行ごとの編集（氏名・ロール）
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState<StaffRole>('trimmer');
  const [editBusy, setEditBusy] = useState(false);

  function startEdit(s: Staff) {
    setMsg(null);
    setEditId(s.id);
    setEditName(s.name);
    setEditRole(s.role);
  }
  async function saveEdit(s: Staff) {
    setEditBusy(true);
    setMsg(null);
    try {
      const roleChanged = editRole !== s.role;
      await updateStaff({ tenantId, targetUid: s.id, name: editName.trim(), role: editRole });
      setMsg(
        roleChanged
          ? `更新しました: ${editName}（${editRole}）。ロール変更は本人の再ログイン後に反映されます。`
          : `更新しました: ${editName}`,
      );
      setEditId(null);
    } catch (err) {
      const m = err instanceof Error ? err.message : '';
      setMsg(
        /own admin role/.test(m)
          ? '自分自身を管理者から外すことはできません。'
          : /another tenant/.test(m)
            ? 'このスタッフは別の店舗に所属しています。'
            : m || '更新に失敗しました',
      );
    } finally {
      setEditBusy(false);
    }
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

      {inviteLink && (
        <div className="invite-link">
          <div className="invite-link-head">
            <strong>{inviteLink.name} のパスワード設定リンク</strong>
            <button type="button" aria-label="閉じる" onClick={() => setInviteLink(null)}>
              ✕
            </button>
          </div>
          <p className="muted">メールが届かない場合は、このリンクをLINE等で本人に共有してください（約1時間有効）。</p>
          <div className="invite-link-row">
            <input readOnly value={inviteLink.link} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" onClick={() => copyLink(inviteLink.link)}>
              {copied ? 'コピーしました' : 'コピー'}
            </button>
          </div>
        </div>
      )}

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
            {staff.map((s) =>
              editId === s.id ? (
                <tr key={s.id}>
                  <td>
                    <input value={editName} onChange={(e) => setEditName(e.target.value)} aria-label="氏名" />
                  </td>
                  <td>
                    <select value={editRole} onChange={(e) => setEditRole(e.target.value as StaffRole)} aria-label="ロール">
                      <option value="trimmer">trimmer</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td>{s.email ?? '—'}</td>
                  <td>{s.active ? '在籍' : '停止'}</td>
                  <td className="row-actions">
                    <button onClick={() => saveEdit(s)} disabled={editBusy || !editName.trim()}>
                      {editBusy ? '保存中…' : '保存'}
                    </button>
                    <button onClick={() => setEditId(null)} disabled={editBusy}>
                      キャンセル
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.role}</td>
                  <td>{s.email ?? '—'}</td>
                  <td>{s.active ? '在籍' : '停止'}</td>
                  <td className="row-actions">
                    <button onClick={() => startEdit(s)}>編集</button>
                    {s.email && <button onClick={() => showInviteLink(s)}>招待リンク</button>}
                    <button onClick={() => toggleActive(s)}>{s.active ? '停止' : '復帰'}</button>
                  </td>
                </tr>
              ),
            )}
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
