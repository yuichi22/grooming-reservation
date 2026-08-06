import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { customersCol } from '../lib/firestore';
import { mergeCustomers } from '../lib/functions';
import { useCollection } from '../lib/useCollection';
import type { Customer } from '../lib/types';

export default function CustomersPage() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId;
  if (!tenantId) return <p className="error">テナントが割り当てられていません。</p>;
  return <CustomersInner tenantId={tenantId} />;
}

function CustomersInner({ tenantId }: { tenantId: string }) {
  const { data: customers, loading } = useCollection<Customer>(customersCol(tenantId), [tenantId]);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const active = customers.filter((c) => !c.mergedInto);

  async function doMerge() {
    if (!source || !target || source === target) {
      setMsg('統合元と統合先に別々の顧客を選んでください');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      // §11 手動マージ: 識別子補完 + 犬/予約の付け替え（サーバで実行）
      const res = await mergeCustomers({ tenantId, sourceCustomerId: source, targetCustomerId: target });
      setMsg(`統合しました（犬 ${res.data.movedDogs} / 予約 ${res.data.movedBookings} を移動）`);
      setSource('');
      setTarget('');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '統合に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>顧客</h1>

      <h2>手動マージ</h2>
      <p className="muted">重複した顧客を1つに統合します（統合元の識別子・犬・予約を統合先へ移動）。</p>
      <div className="row-form">
        <label className="inline">
          統合元
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">選択</option>
            {active.map((c) => (
              <option key={c.id} value={c.id}>
                {c.ownerName || '(名前なし)'} / {c.id}
              </option>
            ))}
          </select>
        </label>
        <span>→</span>
        <label className="inline">
          統合先
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">選択</option>
            {active.map((c) => (
              <option key={c.id} value={c.id}>
                {c.ownerName || '(名前なし)'} / {c.id}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={doMerge} disabled={busy}>
          {busy ? '統合中…' : '統合する'}
        </button>
      </div>
      {msg && <p className="muted">{msg}</p>}

      {loading ? (
        <p>読み込み中…</p>
      ) : (
        <div className="table-wrap"><table>
          <thead>
            <tr>
              <th>氏名</th>
              <th>phone</th>
              <th>lineUserId</th>
              <th>memberId</th>
              <th>状態</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id}>
                <td>{c.ownerName || '—'}</td>
                <td>{c.phone ?? '—'}</td>
                <td><code>{c.lineUserId ?? '—'}</code></td>
                <td>{c.memberId ?? '未連携'}</td>
                <td>{c.mergedInto ? `統合済→${c.mergedInto}` : '有効'}</td>
              </tr>
            ))}
            {customers.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  顧客なし
                </td>
              </tr>
            )}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
