import { useState, type FormEvent } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { staffCol } from '../lib/firestore';
import { setStaffRole } from '../lib/functions';
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

  const [targetUid, setUid] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<StaffRole>('trimmer');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onAssign(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      // 既存の Firebase Auth ユーザの uid に対し権限(custom claims)を付与 (§2)
      await setStaffRole({ tenantId, targetUid: targetUid.trim(), name: name.trim(), role });
      setMsg(`権限を付与しました: ${name}（${role}）`);
      setUid('');
      setName('');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '付与に失敗しました');
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
        Firebase Auth で作成済みのユーザ(uid)に権限を付与します。custom claims(tenantId/role)が設定されます。
      </p>
      <form className="row-form" onSubmit={onAssign}>
        <input placeholder="Firebase Auth UID" value={targetUid} onChange={(e) => setUid(e.target.value)} required />
        <input placeholder="氏名" value={name} onChange={(e) => setName(e.target.value)} required />
        <select value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
          <option value="trimmer">trimmer</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit" disabled={busy}>
          {busy ? '付与中…' : '権限を付与'}
        </button>
      </form>
      {msg && <p className="muted">{msg}</p>}

      {loading ? (
        <p>読み込み中…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>氏名</th>
              <th>role</th>
              <th>uid</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.role}</td>
                <td><code>{s.firebaseUid}</code></td>
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
        </table>
      )}
    </section>
  );
}
