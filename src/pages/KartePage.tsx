import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { addDoc } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { breedsCol, dogsCol } from '../lib/firestore';
import { useCollection } from '../lib/useCollection';
import type { Breed, Dog } from '../lib/types';

export default function KartePage() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId;
  if (!tenantId) return <p className="error">テナントが割り当てられていません。</p>;
  return <KarteInner tenantId={tenantId} />;
}

function KarteInner({ tenantId }: { tenantId: string }) {
  const { data: dogs, loading } = useCollection<Dog>(dogsCol(tenantId), [tenantId]);
  const { data: breeds } = useCollection<Breed>(breedsCol(tenantId), [tenantId]);
  const breedName = useMemo(() => new Map(breeds.map((b) => [b.id, b.name])), [breeds]);

  const [name, setName] = useState('');
  const [breedId, setBreedId] = useState('');
  const [customerId, setCustomerId] = useState('');

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await addDoc(dogsCol(tenantId), {
      customerId: customerId.trim(),
      name: name.trim(),
      breedId: breedId || null,
      confirmedDurationMin: null, // 初回は未確定 (§7)
    } as Omit<Dog, 'id'> as Dog);
    setName('');
    setBreedId('');
    setCustomerId('');
  }

  return (
    <section>
      <h1>カルテ（犬）</h1>
      <form className="row-form" onSubmit={onAdd}>
        <input placeholder="犬の名前" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={breedId} onChange={(e) => setBreedId(e.target.value)}>
          <option value="">犬種を選択</option>
          {breeds.filter((b) => b.active).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <input placeholder="顧客ID" value={customerId} onChange={(e) => setCustomerId(e.target.value)} />
        <button type="submit">追加</button>
      </form>

      {loading ? (
        <p>読み込み中…</p>
      ) : (
        <div className="table-wrap"><table>
          <thead>
            <tr>
              <th>名前</th>
              <th>犬種</th>
              <th>確定作業時間</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {dogs.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>{(d.breedId && breedName.get(d.breedId)) || d.breed || '—'}</td>
                <td>{d.confirmedDurationMin != null ? `${d.confirmedDurationMin}分` : '未確定'}</td>
                <td>
                  <Link to={`/karte/${d.id}`}>開く</Link>
                </td>
              </tr>
            ))}
            {dogs.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
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
