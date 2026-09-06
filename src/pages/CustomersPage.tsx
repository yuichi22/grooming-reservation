import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
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
  const [mergeOpen, setMergeOpen] = useState(false); // まとめ機能は普段使わないためアコーディオンで畳んでおく

  const active = customers.filter((c) => !c.mergedInto);
  const label = (c: Customer) => `${c.ownerName || '(名前なし)'}${c.phone ? `（${c.phone}）` : ''}`;

  async function doMerge() {
    if (!source || !target || source === target) {
      setMsg('「消える方」と「残す方」に別々のお客様を選んでください');
      return;
    }
    const src = active.find((c) => c.id === source);
    const tgt = active.find((c) => c.id === target);
    if (!confirm(`「${src ? label(src) : ''}」を「${tgt ? label(tgt) : ''}」にまとめます。よろしいですか？`)) return;
    setBusy(true);
    setMsg(null);
    try {
      // 手動マージ: 識別子補完 + 犬/予約の付け替え（サーバで実行）
      const res = await mergeCustomers({ tenantId, sourceCustomerId: source, targetCustomerId: target });
      setMsg(`1件にまとめました（ワンちゃん ${res.data.movedDogs} / 予約 ${res.data.movedBookings} を引き継ぎ）`);
      setSource('');
      setTarget('');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'まとめられませんでした');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>顧客</h1>

      {/* 重複顧客の統合。トリマーにも分かる言葉にし、普段は畳んでおく */}
      <button type="button" className="cal-acc-head" onClick={() => setMergeOpen((o) => !o)}>
        {mergeOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        重複したお客様を1件にまとめる
      </button>
      {mergeOpen && (
        <div className="cal-acc-body">
          <p className="muted">
            同じ飼い主さんが2件で登録されてしまったときに使います。
            「消える方」のワンちゃん・予約・連絡先は「残す方」に引き継がれ、消える方は一覧から外れます。
          </p>
          <div className="row-form">
            <label className="inline">
              消える方
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">選択</option>
                {active.map((c) => (
                  <option key={c.id} value={c.id}>
                    {label(c)}
                  </option>
                ))}
              </select>
            </label>
            <span>→</span>
            <label className="inline">
              残す方
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">選択</option>
                {active.map((c) => (
                  <option key={c.id} value={c.id}>
                    {label(c)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={doMerge} disabled={busy}>
              {busy ? 'まとめ中…' : '1件にまとめる'}
            </button>
          </div>
          {msg && <p className="muted">{msg}</p>}
        </div>
      )}

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
