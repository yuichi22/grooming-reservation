import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { addDoc } from 'firebase/firestore';
import { ChevronRight, Plus } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { breedsCol, customersCol, dogsCol } from '../lib/firestore';
import { useCollection } from '../lib/useCollection';
import type { Breed, Customer, Dog } from '../lib/types';

export default function KartePage() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId;
  if (!tenantId) return <p className="error">テナントが割り当てられていません。</p>;
  return <KarteInner tenantId={tenantId} />;
}

function KarteInner({ tenantId }: { tenantId: string }) {
  const navigate = useNavigate();
  const { data: dogs, loading } = useCollection<Dog>(dogsCol(tenantId), [tenantId]);
  const { data: breeds } = useCollection<Breed>(breedsCol(tenantId), [tenantId]);
  const { data: customers } = useCollection<Customer>(customersCol(tenantId), [tenantId]);
  const breedName = useMemo(() => new Map(breeds.map((b) => [b.id, b.name])), [breeds]);
  const customerName = useMemo(() => new Map(customers.map((c) => [c.id, c.ownerName])), [customers]);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [breedId, setBreedId] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  function closeModal() {
    if (busy) return;
    setOpen(false);
    setName('');
    setBreedId('');
    setOwnerName('');
    setPhone('');
  }

  // §3 名寄せは電話番号で行うため、店頭でカルテを作るときに顧客（名前＋電話）も作成/再利用しておく。
  // 同じ電話で顧客が後から LINE 登録すると自動的にこの犬が紐づく。
  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const trimmedPhone = phone.trim();
      let customerId = '';
      if (trimmedPhone) {
        const existing = customers.find((c) => !c.mergedInto && c.phone === trimmedPhone);
        if (existing) customerId = existing.id;
      }
      if (!customerId) {
        const cref = await addDoc(customersCol(tenantId), {
          memberId: null,
          ownerName: ownerName.trim(),
          phone: trimmedPhone || null,
          lineUserId: null,
          createdAt: new Date().toISOString(),
        } as Omit<Customer, 'id'> as Customer);
        customerId = cref.id;
      }
      const dref = await addDoc(dogsCol(tenantId), {
        customerId,
        name: name.trim(),
        breedId: breedId || null,
        confirmedDurationMin: null, // 初回は未確定 (§7)
      } as Omit<Dog, 'id'> as Dog);
      // 追加したら詳細（カルテ）を開く
      setOpen(false);
      navigate(`/karte/${dref.id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="page-head">
        <h1>カルテ（犬）</h1>
        <button type="button" onClick={() => setOpen(true)}>
          <Plus size={16} style={{ marginRight: 6, verticalAlign: '-2px' }} />
          カルテを追加
        </button>
      </div>

      {open && (
        <div className="modal-backdrop" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>カルテを追加</h2>
            <form onSubmit={onAdd}>
              <label>
                犬の名前
                <input placeholder="犬の名前" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                犬種
                <select value={breedId} onChange={(e) => setBreedId(e.target.value)}>
                  <option value="">犬種を選択</option>
                  {breeds.filter((b) => b.active).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                飼い主名（任意）
                <input placeholder="飼い主名（任意）" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
              </label>
              <label>
                電話番号（任意）
                <input placeholder="電話番号（任意）" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </label>
              <p className="muted">
                電話番号を入れておくと、その方が同じ番号で LINE 登録したときに自動でこの犬が紐づきます（§3）。
              </p>
              <div className="modal-actions">
                <button type="button" onClick={closeModal} disabled={busy}>
                  キャンセル
                </button>
                <button type="submit" disabled={busy || !name.trim()}>
                  {busy ? '作成中…' : 'カルテを追加'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loading ? (
        <p>読み込み中…</p>
      ) : (
        <div className="table-wrap"><table>
          <thead>
            <tr>
              <th>名前</th>
              <th>犬種</th>
              <th>飼い主</th>
              <th>確定作業時間</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {dogs.map((d) => (
              <tr key={d.id} className="row-link" onClick={() => navigate(`/karte/${d.id}`)}>
                <td>{d.name}</td>
                <td>{(d.breedId && breedName.get(d.breedId)) || d.breed || '—'}</td>
                <td>{customerName.get(d.customerId) || '—'}</td>
                <td>{d.confirmedDurationMin != null ? `${d.confirmedDurationMin}分` : '未確定'}</td>
                <td className="chevron-cell">
                  <ChevronRight size={18} />
                </td>
              </tr>
            ))}
            {dogs.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  カルテ未登録
                </td>
              </tr>
            )}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
