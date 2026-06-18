import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { addDoc, doc, updateDoc } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { dogsCol, recordsCol } from '../lib/firestore';
import { useCollection } from '../lib/useCollection';
import { useDocument } from '../lib/useDocument';
import type { Dog, ServiceRecord } from '../lib/types';

export default function DogDetailPage() {
  const { claims } = useAuth();
  const { dogId } = useParams<{ dogId: string }>();
  const tenantId = claims.tenantId;
  if (!tenantId) return <p className="error">テナントが割り当てられていません。</p>;
  if (!dogId) return <p className="error">犬が指定されていません。</p>;
  return <DogDetailInner tenantId={tenantId} dogId={dogId} />;
}

function DogDetailInner({ tenantId, dogId }: { tenantId: string; dogId: string }) {
  const { data: dog, loading } = useDocument<Dog>(doc(dogsCol(tenantId), dogId), [tenantId, dogId]);
  const { data: records } = useCollection<ServiceRecord>(recordsCol(tenantId, dogId), [tenantId, dogId]);

  const [form, setForm] = useState<Partial<Dog>>({});
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (dog) {
      setForm({
        notes: dog.notes ?? '',
        allergies: dog.allergies ?? '',
        confirmedDurationMin: dog.confirmedDurationMin,
        confirmedPrice: dog.confirmedPrice ?? null,
      });
    }
  }, [dog]);

  if (loading) return <p>読み込み中…</p>;
  if (!dog) return <p className="error">カルテが見つかりません。</p>;

  async function saveDog(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    await updateDoc(doc(dogsCol(tenantId), dogId), {
      notes: form.notes ?? '',
      allergies: form.allergies ?? '',
      confirmedDurationMin: form.confirmedDurationMin ?? null,
      confirmedPrice: form.confirmedPrice ?? null,
    });
    setMsg('保存しました');
  }

  return (
    <section>
      <p>
        <Link to="/karte">← カルテ一覧</Link>
      </p>
      <h1>{dog.name}</h1>
      <p className="muted">
        {dog.breed ?? '犬種未設定'} / 顧客ID: {dog.customerId || '—'}
      </p>

      <form onSubmit={saveDog}>
        <label className="inline">
          確定作業時間(分・空なら未確定) (§7)
          <input
            type="number"
            min={0}
            step={5}
            value={form.confirmedDurationMin ?? ''}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                confirmedDurationMin: e.target.value === '' ? null : Number(e.target.value),
              }))
            }
          />
        </label>
        <label className="inline">
          確定料金
          <input
            type="number"
            min={0}
            step={100}
            value={form.confirmedPrice ?? ''}
            onChange={(e) =>
              setForm((f) => ({ ...f, confirmedPrice: e.target.value === '' ? null : Number(e.target.value) }))
            }
          />
        </label>
        <label>
          メモ（噛み癖・サイズ等）
          <textarea
            value={form.notes ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </label>
        <label>
          アレルギー
          <input
            value={form.allergies ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, allergies: e.target.value }))}
          />
        </label>
        <div>
          <button type="submit">保存</button>
          {msg && <span className="muted" style={{ marginLeft: 12 }}>{msg}</span>}
        </div>
      </form>

      <h2>施術履歴</h2>
      <RecordForm tenantId={tenantId} dogId={dogId} />
      <div className="table-wrap"><table>
        <thead>
          <tr>
            <th>日付</th>
            <th>メニュー</th>
            <th>作業時間</th>
            <th>料金</th>
            <th>メモ</th>
          </tr>
        </thead>
        <tbody>
          {[...records]
            .sort((a, b) => b.date.localeCompare(a.date))
            .map((r) => (
              <tr key={r.id}>
                <td>{r.date}</td>
                <td>{r.menuId}</td>
                <td>{r.durationMin}分</td>
                <td>¥{r.price.toLocaleString()}</td>
                <td>{r.notes ?? '—'}</td>
              </tr>
            ))}
          {records.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                履歴なし
              </td>
            </tr>
          )}
        </tbody>
      </table></div>
    </section>
  );
}

function RecordForm({ tenantId, dogId }: { tenantId: string; dogId: string }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [menuId, setMenuId] = useState('');
  const [durationMin, setDuration] = useState(80);
  const [price, setPrice] = useState(5500);
  const [notes, setNotes] = useState('');

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    await addDoc(recordsCol(tenantId, dogId), {
      bookingId: '',
      date,
      menuId: menuId.trim(),
      staffId: '',
      durationMin,
      price,
      notes: notes.trim() || undefined,
    } as Omit<ServiceRecord, 'id'> as ServiceRecord);
    setNotes('');
  }

  return (
    <form className="row-form" onSubmit={onAdd}>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <input placeholder="メニューID" value={menuId} onChange={(e) => setMenuId(e.target.value)} />
      <input type="number" min={0} step={5} value={durationMin} onChange={(e) => setDuration(Number(e.target.value))} />
      <input type="number" min={0} step={100} value={price} onChange={(e) => setPrice(Number(e.target.value))} />
      <input placeholder="メモ" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <button type="submit">履歴を追加</button>
    </form>
  );
}
