import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { addDoc } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { dogsCol } from '../lib/firestore';
import { useCollection } from '../lib/useCollection';
import type { Dog } from '../lib/types';

export default function KartePage() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId;
  if (!tenantId) return <p className="error">テナントが割り当てられていません。</p>;
  return <KarteInner tenantId={tenantId} />;
}

function KarteInner({ tenantId }: { tenantId: string }) {
  const { data: dogs, loading } = useCollection<Dog>(dogsCol(tenantId), [tenantId]);

  const [name, setName] = useState('');
  const [breed, setBreed] = useState('');
  const [customerId, setCustomerId] = useState('');

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await addDoc(dogsCol(tenantId), {
      customerId: customerId.trim(),
      name: name.trim(),
      breed: breed.trim() || undefined,
      confirmedDurationMin: null, // 初回は未確定 (§7)
    } as Omit<Dog, 'id'> as Dog);
    setName('');
    setBreed('');
    setCustomerId('');
  }

  return (
    <section>
      <h1>カルテ（犬）</h1>
      <form className="row-form" onSubmit={onAdd}>
        <input placeholder="犬の名前" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="犬種" value={breed} onChange={(e) => setBreed(e.target.value)} />
        <input placeholder="顧客ID" value={customerId} onChange={(e) => setCustomerId(e.target.value)} />
        <button type="submit">追加</button>
      </form>

      {loading ? (
        <p>読み込み中…</p>
      ) : (
        <table>
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
                <td>{d.breed ?? '—'}</td>
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
        </table>
      )}
    </section>
  );
}
