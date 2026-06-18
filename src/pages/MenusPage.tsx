import { useState, type FormEvent } from 'react';
import { addDoc, deleteDoc, doc, setDoc, updateDoc } from 'firebase/firestore';
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
      <PriceTable tenantId={tenantId} breeds={breeds} services={services} pricing={pricing} />
    </>
  );
}

type NamedItem = { id: string; name: string; active: boolean };

/** 名前のみのマスタ（犬種・サービス共通）。 */
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
    <section>
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
    </section>
  );
}

/** 料金表: 犬種を選択 → サービスごとに金額・所要時間を登録。 */
function PriceTable({
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
  const [breedId, setBreedId] = useState('');
  const activeServices = services.filter((s) => s.active);

  return (
    <section>
      <h2>料金表（犬種 × サービス）</h2>
      <p className="muted">犬種を選び、サービスごとに金額と所要時間を登録します。</p>
      <label className="inline">
        犬種
        <select value={breedId} onChange={(e) => setBreedId(e.target.value)}>
          <option value="">選択してください</option>
          {breeds
            .filter((b) => b.active)
            .map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
        </select>
      </label>

      {breedId && activeServices.length === 0 && <p className="muted">先にサービスを登録してください。</p>}
      {breedId && activeServices.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>サービス</th>
                <th>金額(円)</th>
                <th>所要(分)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {activeServices.map((s) => {
                const cell = pricing.find((p) => p.breedId === breedId && p.serviceId === s.id) ?? null;
                return <PriceRow key={s.id} tenantId={tenantId} breedId={breedId} service={s} cell={cell} />;
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PriceRow({
  tenantId,
  breedId,
  service,
  cell,
}: {
  tenantId: string;
  breedId: string;
  service: Service;
  cell: PriceEntry | null;
}) {
  const [price, setPrice] = useState<number>(cell?.price ?? 0);
  const [durationMin, setDuration] = useState<number>(cell?.durationMin ?? 60);
  const [saved, setSaved] = useState(false);

  async function save() {
    const id = `${breedId}__${service.id}`;
    await setDoc(doc(pricingCol(tenantId), id), {
      breedId,
      serviceId: service.id,
      price,
      durationMin,
      active: true,
    } as Omit<PriceEntry, 'id'> as PriceEntry);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <tr>
      <td>{service.name}</td>
      <td>
        <input type="number" min={0} step={100} value={price} onChange={(e) => setPrice(Number(e.target.value))} />
      </td>
      <td>
        <input type="number" min={5} step={5} value={durationMin} onChange={(e) => setDuration(Number(e.target.value))} />
      </td>
      <td>
        <button onClick={save}>保存</button>
        {saved && <span className="muted" style={{ marginLeft: 6 }}>✓</span>}
        {!cell && <span className="muted" style={{ marginLeft: 6 }}>未登録</span>}
      </td>
    </tr>
  );
}
