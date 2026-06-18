import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { addDoc, doc, updateDoc } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { breedsCol, dogsCol, recordsCol, servicesCol } from '../lib/firestore';
import { useCollection } from '../lib/useCollection';
import { useDocument } from '../lib/useDocument';
import type { Breed, Dog, Service, ServiceRecord } from '../lib/types';

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
  const { data: breeds } = useCollection<Breed>(breedsCol(tenantId), [tenantId]);
  const { data: services } = useCollection<Service>(servicesCol(tenantId), [tenantId]);
  const serviceName = useMemo(() => new Map(services.map((s) => [s.id, s.name])), [services]);

  const [form, setForm] = useState<Partial<Dog>>({});
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (dog) {
      setForm({
        breedId: dog.breedId ?? null,
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
      breedId: form.breedId ?? null,
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
      <p className="muted">顧客ID: {dog.customerId || '—'}</p>

      <form onSubmit={saveDog}>
        <label className="inline">
          犬種
          <select
            value={form.breedId ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, breedId: e.target.value || null }))}
          >
            <option value="">未設定</option>
            {breeds.filter((b) => b.active).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
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
      <RecordForm tenantId={tenantId} dogId={dogId} services={services} />
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
                <td>{serviceName.get(r.serviceId) ?? r.serviceId}</td>
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

function RecordForm({ tenantId, dogId, services }: { tenantId: string; dogId: string; services: Service[] }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [serviceId, setServiceId] = useState('');
  const [durationMin, setDuration] = useState(80);
  const [price, setPrice] = useState(5500);
  const [notes, setNotes] = useState('');

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!serviceId) return;
    await addDoc(recordsCol(tenantId, dogId), {
      bookingId: '',
      date,
      serviceId,
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
      <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
        <option value="">サービス</option>
        {services.filter((s) => s.active).map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <input type="number" min={0} step={5} value={durationMin} onChange={(e) => setDuration(Number(e.target.value))} />
      <input type="number" min={0} step={100} value={price} onChange={(e) => setPrice(Number(e.target.value))} />
      <input placeholder="メモ" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <button type="submit">履歴を追加</button>
    </form>
  );
}
