import { useMemo, useState, type FormEvent } from 'react';
import { addDoc, deleteDoc, doc, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebaseStaff';
import { useAuth } from '../auth/AuthContext';
import { breedsCol, pricingCol, servicesCol } from '../lib/firestore';
import { useCollection } from '../lib/useCollection';
import type { Breed, PriceEntry, Service } from '../lib/types';

export default function MenusPage() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId;
  if (!tenantId) return <p className="error">テナントが割り当てられていません。</p>;
  return <MenusInner tenantId={tenantId} />;
}

function MenusInner({ tenantId }: { tenantId: string }) {
  const { data: breeds } = useCollection<Breed>(breedsCol(tenantId), [tenantId]);
  const { data: services } = useCollection<Service>(servicesCol(tenantId), [tenantId]);
  const { data: pricing } = useCollection<PriceEntry>(pricingCol(tenantId), [tenantId]);
  const [tab, setTab] = useState<'pricing' | 'masters'>('pricing');

  return (
    <section>
      <h1>メニュー</h1>
      <div className="tabs">
        <button className={`tab ${tab === 'pricing' ? 'active' : ''}`} onClick={() => setTab('pricing')}>
          料金表
        </button>
        <button className={`tab ${tab === 'masters' ? 'active' : ''}`} onClick={() => setTab('masters')}>
          犬種・サービス設定
        </button>
      </div>

      {tab === 'pricing' ? (
        <PricingTab tenantId={tenantId} breeds={breeds} services={services} pricing={pricing} />
      ) : (
        <MastersTab tenantId={tenantId} breeds={breeds} services={services} />
      )}
    </section>
  );
}

/* ============ 料金表タブ ============ */
function PricingTab({
  tenantId,
  breeds,
  services,
  pricing,
}: {
  tenantId: string;
  breeds: Breed[];
  services: Service[];
  pricing: PriceEntry[];
}) {
  const breedName = useMemo(() => new Map(breeds.map((b) => [b.id, b.name])), [breeds]);
  const serviceName = useMemo(() => new Map(services.map((s) => [s.id, s.name])), [services]);
  const sorted = useMemo(
    () => [...pricing].sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999) || a.id.localeCompare(b.id)),
    [pricing],
  );

  const [breedId, setBreedId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [price, setPrice] = useState(5000);
  const [durationMin, setDuration] = useState(60);
  const [msg, setMsg] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!breedId || !serviceId) {
      setMsg('犬種とサービスを選んでください');
      return;
    }
    const id = `${breedId}__${serviceId}`;
    const maxOrder = sorted.reduce((m, p) => Math.max(m, p.order ?? 0), 0);
    await setDoc(doc(pricingCol(tenantId), id), {
      breedId,
      serviceId,
      price,
      durationMin,
      active: true,
      order: maxOrder + 1,
    } as Omit<PriceEntry, 'id'> as PriceEntry);
    setMsg(null);
    setBreedId('');
    setServiceId('');
  }

  async function move(index: number, dir: -1 | 1) {
    const next = index + dir;
    if (next < 0 || next >= sorted.length) return;
    const arr = [...sorted];
    [arr[index], arr[next]] = [arr[next], arr[index]];
    // 並び替え後の順序を全カードに書き戻す
    const batch = writeBatch(db);
    arr.forEach((p, i) => batch.update(doc(pricingCol(tenantId), p.id), { order: i }));
    await batch.commit();
  }

  return (
    <>
      <p className="muted">犬種とサービスを選び、金額・所要時間を入力して「追加」。カードは編集・並べ替えできます。</p>
      <form className="row-form" onSubmit={add}>
        <select value={breedId} onChange={(e) => setBreedId(e.target.value)}>
          <option value="">犬種</option>
          {breeds.filter((b) => b.active).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
          <option value="">サービス</option>
          {services.filter((s) => s.active).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <input type="number" min={0} step={100} value={price} onChange={(e) => setPrice(Number(e.target.value))} />
        <input type="number" min={5} step={5} value={durationMin} onChange={(e) => setDuration(Number(e.target.value))} />
        <button type="submit">＋ 追加</button>
      </form>
      {msg && <p className="error">{msg}</p>}

      <div className="price-cards">
        {sorted.map((p, i) => (
          <PriceCard
            key={p.id}
            tenantId={tenantId}
            entry={p}
            breedName={breedName.get(p.breedId) ?? p.breedId}
            serviceName={serviceName.get(p.serviceId) ?? p.serviceId}
            canUp={i > 0}
            canDown={i < sorted.length - 1}
            onUp={() => move(i, -1)}
            onDown={() => move(i, 1)}
          />
        ))}
        {sorted.length === 0 && <p className="muted">料金表が空です。上のフォームから追加してください。</p>}
      </div>
    </>
  );
}

function PriceCard({
  tenantId,
  entry,
  breedName,
  serviceName,
  canUp,
  canDown,
  onUp,
  onDown,
}: {
  tenantId: string;
  entry: PriceEntry;
  breedName: string;
  serviceName: string;
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState(entry.price);
  const [durationMin, setDuration] = useState(entry.durationMin);

  async function save() {
    await updateDoc(doc(pricingCol(tenantId), entry.id), { price, durationMin });
    setEditing(false);
  }
  async function remove() {
    if (confirm(`「${breedName} × ${serviceName}」を削除しますか？`)) {
      await deleteDoc(doc(pricingCol(tenantId), entry.id));
    }
  }

  return (
    <div className="price-card">
      <div className="price-card-head">
        <span className="price-card-title">
          {breedName} <span className="muted">×</span> {serviceName}
        </span>
        <span className="price-card-reorder">
          <button onClick={onUp} disabled={!canUp} aria-label="上へ">
            ↑
          </button>
          <button onClick={onDown} disabled={!canDown} aria-label="下へ">
            ↓
          </button>
        </span>
      </div>
      {editing ? (
        <div className="row-form" style={{ margin: '8px 0 0' }}>
          <label className="inline">
            ¥
            <input type="number" min={0} step={100} value={price} onChange={(e) => setPrice(Number(e.target.value))} />
          </label>
          <label className="inline">
            分
            <input type="number" min={5} step={5} value={durationMin} onChange={(e) => setDuration(Number(e.target.value))} />
          </label>
          <button type="button" onClick={save}>
            保存
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            取消
          </button>
        </div>
      ) : (
        <div className="price-card-body">
          <span className="price-card-price">¥{entry.price.toLocaleString()}</span>
          <span className="muted">{entry.durationMin}分</span>
          <span className="price-card-actions">
            <button onClick={() => setEditing(true)}>編集</button>
            <button onClick={remove}>削除</button>
          </span>
        </div>
      )}
    </div>
  );
}

/* ============ 犬種・サービス設定タブ ============ */
function MastersTab({ tenantId, breeds, services }: { tenantId: string; breeds: Breed[]; services: Service[] }) {
  return (
    <>
      <NameMaster
        title="犬種マスタ"
        items={breeds}
        placeholder="例: トイプードル"
        onAdd={(name) => addDoc(breedsCol(tenantId), { name, active: true } as Omit<Breed, 'id'> as Breed)}
        onToggle={(it) => updateDoc(doc(breedsCol(tenantId), it.id), { active: !it.active })}
        onRemove={(it) => deleteDoc(doc(breedsCol(tenantId), it.id))}
      />
      <NameMaster
        title="サービスマスタ"
        items={services}
        placeholder="例: カット / シャンプー"
        onAdd={(name) => addDoc(servicesCol(tenantId), { name, active: true } as Omit<Service, 'id'> as Service)}
        onToggle={(it) => updateDoc(doc(servicesCol(tenantId), it.id), { active: !it.active })}
        onRemove={(it) => deleteDoc(doc(servicesCol(tenantId), it.id))}
      />
    </>
  );
}

type NamedItem = { id: string; name: string; active: boolean };

function NameMaster({
  title,
  items,
  placeholder,
  onAdd,
  onToggle,
  onRemove,
}: {
  title: string;
  items: NamedItem[];
  placeholder: string;
  onAdd: (name: string) => Promise<unknown>;
  onToggle: (it: NamedItem) => Promise<unknown>;
  onRemove: (it: NamedItem) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await onAdd(name.trim());
    setName('');
  }
  return (
    <div style={{ marginTop: 18 }}>
      <h2>{title}</h2>
      <form className="row-form" onSubmit={add}>
        <input placeholder={placeholder} value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit">追加</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>名前</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {[...items]
              .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
              .map((it) => (
                <tr key={it.id}>
                  <td>{it.name}</td>
                  <td>{it.active ? '有効' : '無効'}</td>
                  <td>
                    <button onClick={() => onToggle(it)}>{it.active ? '無効化' : '有効化'}</button>
                    <button onClick={() => onRemove(it)}>削除</button>
                  </td>
                </tr>
              ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  未登録
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
