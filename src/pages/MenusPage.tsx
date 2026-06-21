import { useMemo, useState, type FormEvent } from 'react';
import { addDoc, deleteDoc, doc, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebaseStaff';
import { useAuth } from '../auth/AuthContext';
import { breedsCol, optionsCol, pricingCol, servicesCol, tenantDoc } from '../lib/firestore';
import { useCollection } from '../lib/useCollection';
import { useDocument } from '../lib/useDocument';
import type { Breed, Option, PriceEntry, Service, Tenant } from '../lib/types';

/** 金額を税表示付きで整形（税抜なら税込も併記）。 */
function priceLabel(price: number, taxMode: 'inclusive' | 'exclusive', taxRate: number): string {
  if (taxMode === 'inclusive') return `¥${price.toLocaleString()}（税込）`;
  const incl = Math.round(price * (1 + taxRate / 100));
  return `¥${price.toLocaleString()}（税込¥${incl.toLocaleString()}）`;
}

export default function MenusPage() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId;
  if (!tenantId) return <p className="error">テナントが割り当てられていません。</p>;
  return <MenusInner tenantId={tenantId} />;
}

function MenusInner({ tenantId }: { tenantId: string }) {
  const { data: breeds } = useCollection<Breed>(breedsCol(tenantId), [tenantId]);
  const { data: services } = useCollection<Service>(servicesCol(tenantId), [tenantId]);
  const { data: optionItems } = useCollection<Option>(optionsCol(tenantId), [tenantId]);
  const { data: pricing } = useCollection<PriceEntry>(pricingCol(tenantId), [tenantId]);
  const { data: tenant } = useDocument<Tenant>(tenantDoc(tenantId), [tenantId]);
  const taxMode = tenant?.settings?.taxMode ?? 'exclusive';
  const taxRate = tenant?.settings?.taxRate ?? 10;
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
        <PricingTab
          tenantId={tenantId}
          breeds={breeds}
          services={services}
          pricing={pricing}
          taxMode={taxMode}
          taxRate={taxRate}
        />
      ) : (
        <MastersTab tenantId={tenantId} breeds={breeds} services={services} optionItems={optionItems} />
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
  taxMode,
  taxRate,
}: {
  tenantId: string;
  breeds: Breed[];
  services: Service[];
  pricing: PriceEntry[];
  taxMode: 'inclusive' | 'exclusive';
  taxRate: number;
}) {
  const serviceName = useMemo(() => new Map(services.map((s) => [s.id, s.name])), [services]);
  const sorted = useMemo(
    () => [...pricing].sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999) || a.id.localeCompare(b.id)),
    [pricing],
  );

  const [breedId, setBreedId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [price, setPrice] = useState('');
  const [durationMin, setDuration] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!breedId || !serviceId) {
      setMsg('犬種とサービスを選んでください');
      return;
    }
    if (price === '' || durationMin === '') {
      setMsg('料金と作業時間を入力してください');
      return;
    }
    const id = `${breedId}__${serviceId}`;
    const maxOrder = sorted.reduce((m, p) => Math.max(m, p.order ?? 0), 0);
    await setDoc(doc(pricingCol(tenantId), id), {
      breedId,
      serviceId,
      price: Number(price),
      durationMin: Number(durationMin),
      active: true,
      order: maxOrder + 1,
    } as Omit<PriceEntry, 'id'> as PriceEntry);
    setMsg(null);
    setBreedId('');
    setServiceId('');
    setPrice('');
    setDuration('');
  }

  // 犬種ごとにグループ化。カードの並びは犬種(breed.order)順。
  const groups = useMemo(() => {
    const m = new Map<string, PriceEntry[]>();
    for (const p of sorted) {
      if (!m.has(p.breedId)) m.set(p.breedId, []);
      m.get(p.breedId)!.push(p);
    }
    return [...breeds]
      .filter((b) => m.has(b.id))
      .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999) || a.name.localeCompare(b.name, 'ja'))
      .map((b) => ({ breed: b, entries: m.get(b.id) ?? [] }));
  }, [sorted, breeds]);

  // 犬種カードの並べ替え（breed.order を書き戻す）
  async function moveBreed(index: number, dir: -1 | 1) {
    const next = index + dir;
    if (next < 0 || next >= groups.length) return;
    const arr = groups.map((g) => g.breed);
    [arr[index], arr[next]] = [arr[next], arr[index]];
    const batch = writeBatch(db);
    arr.forEach((b, i) => batch.update(doc(breedsCol(tenantId), b.id), { order: i }));
    await batch.commit();
  }

  return (
    <>
      <p className="muted">犬種とサービスを選び、金額・所要時間を入力して「追加」。犬種ごとにカードで表示されます。</p>
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
        <input
          type="number"
          min={0}
          step={100}
          placeholder="料金"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
        <input
          type="number"
          min={5}
          step={5}
          placeholder="作業時間"
          value={durationMin}
          onChange={(e) => setDuration(e.target.value)}
        />
        <button type="submit">＋ 追加</button>
      </form>
      {msg && <p className="error">{msg}</p>}

      <div className="price-cards">
        {groups.map((g, i) => (
          <BreedCard
            key={g.breed.id}
            tenantId={tenantId}
            breedName={g.breed.name}
            entries={g.entries}
            serviceName={serviceName}
            taxMode={taxMode}
            taxRate={taxRate}
            canUp={i > 0}
            canDown={i < groups.length - 1}
            onUp={() => moveBreed(i, -1)}
            onDown={() => moveBreed(i, 1)}
          />
        ))}
        {groups.length === 0 && <p className="muted">料金表が空です。上のフォームから追加してください。</p>}
      </div>
    </>
  );
}

/** 犬種カード: ヘッダーに犬種名＋並べ替え、本体にサービス行リスト。 */
function BreedCard({
  tenantId,
  breedName,
  entries,
  serviceName,
  taxMode,
  taxRate,
  canUp,
  canDown,
  onUp,
  onDown,
}: {
  tenantId: string;
  breedName: string;
  entries: PriceEntry[];
  serviceName: Map<string, string>;
  taxMode: 'inclusive' | 'exclusive';
  taxRate: number;
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
}) {
  return (
    <div className="price-card">
      <div className="price-card-head">
        <span className="price-card-title">{breedName}</span>
        <span className="price-card-reorder">
          <button onClick={onUp} disabled={!canUp} aria-label="犬種を上へ">↑</button>
          <button onClick={onDown} disabled={!canDown} aria-label="犬種を下へ">↓</button>
        </span>
      </div>
      <ul className="svc-list">
        {entries.map((e) => (
          <ServiceRow
            key={e.id}
            tenantId={tenantId}
            entry={e}
            serviceName={serviceName.get(e.serviceId) ?? e.serviceId}
            taxMode={taxMode}
            taxRate={taxRate}
          />
        ))}
        {entries.length === 0 && <li className="muted">サービス未設定</li>}
      </ul>
    </div>
  );
}

function ServiceRow({
  tenantId,
  entry,
  serviceName,
  taxMode,
  taxRate,
}: {
  tenantId: string;
  entry: PriceEntry;
  serviceName: string;
  taxMode: 'inclusive' | 'exclusive';
  taxRate: number;
}) {
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState(entry.price);
  const [durationMin, setDuration] = useState(entry.durationMin);

  async function save() {
    await updateDoc(doc(pricingCol(tenantId), entry.id), { price, durationMin });
    setEditing(false);
  }
  async function remove() {
    if (confirm(`「${serviceName}」を削除しますか？`)) {
      await deleteDoc(doc(pricingCol(tenantId), entry.id));
    }
  }

  if (editing) {
    return (
      <li className="svc-row">
        <span className="svc-name">{serviceName}</span>
        <input type="number" min={0} step={100} value={price} onChange={(e) => setPrice(Number(e.target.value))} style={{ width: 90 }} />
        <input type="number" min={5} step={5} value={durationMin} onChange={(e) => setDuration(Number(e.target.value))} style={{ width: 70 }} />
        <span className="svc-actions">
          <button type="button" onClick={save}>保存</button>
          <button type="button" onClick={() => setEditing(false)}>取消</button>
        </span>
      </li>
    );
  }

  return (
    <li className="svc-row">
      <span className="svc-name">{serviceName}</span>
      <span className="svc-price">{priceLabel(entry.price, taxMode, taxRate)}</span>
      <span className="muted">{entry.durationMin}分</span>
      <span className="svc-actions">
        <button onClick={() => setEditing(true)}>編集</button>
        <button onClick={remove}>削除</button>
      </span>
    </li>
  );
}

/* ============ 犬種・サービス設定タブ ============ */
function MastersTab({
  tenantId,
  breeds,
  services,
  optionItems,
}: {
  tenantId: string;
  breeds: Breed[];
  services: Service[];
  optionItems: Option[];
}) {
  return (
    <>
      <BreedMaster tenantId={tenantId} breeds={breeds} />
      <ServiceMaster tenantId={tenantId} services={services} />
      <OptionMaster tenantId={tenantId} optionItems={optionItems} />
    </>
  );
}

/** サービスマスタ: 名前のみ（オプションは独立マスタ）。 */
function ServiceMaster({ tenantId, services }: { tenantId: string; services: Service[] }) {
  const [name, setName] = useState('');
  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await addDoc(servicesCol(tenantId), { name: name.trim(), active: true } as Omit<Service, 'id'> as Service);
    setName('');
  }
  return (
    <div style={{ marginTop: 18 }}>
      <h2>サービスマスタ</h2>
      <form className="row-form" onSubmit={add}>
        <input placeholder="例: カット / シャンプー" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit">サービスを追加</button>
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
            {[...services]
              .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
              .map((s) => (
                <ServiceMasterRow key={s.id} tenantId={tenantId} service={s} />
              ))}
            {services.length === 0 && (
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

function ServiceMasterRow({ tenantId, service }: { tenantId: string; service: Service }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(service.name);

  async function save() {
    if (!name.trim()) return;
    await updateDoc(doc(servicesCol(tenantId), service.id), { name: name.trim() });
    setEditing(false);
  }

  return (
    <tr>
      <td>
        {editing ? (
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: 160 }} />
        ) : (
          service.name
        )}
      </td>
      <td>{service.active ? '有効' : '無効'}</td>
      <td>
        {editing ? (
          <>
            <button onClick={save}>保存</button>
            <button onClick={() => { setName(service.name); setEditing(false); }}>取消</button>
          </>
        ) : (
          <>
            <button onClick={() => setEditing(true)}>編集</button>
            <button onClick={() => updateDoc(doc(servicesCol(tenantId), service.id), { active: !service.active })}>
              {service.active ? '無効化' : '有効化'}
            </button>
            <button onClick={() => deleteDoc(doc(servicesCol(tenantId), service.id))}>削除</button>
          </>
        )}
      </td>
    </tr>
  );
}

/** オプションマスタ: サービスから独立。名前＋料金＋追加時間。顧客はサービスと別に選べる。 */
function OptionMaster({ tenantId, optionItems }: { tenantId: string; optionItems: Option[] }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState(0);
  const [dur, setDur] = useState(15);
  const [standalone, setStandalone] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await addDoc(optionsCol(tenantId), {
      name: name.trim(),
      price,
      durationMin: dur,
      active: true,
      standalone,
    } as Omit<Option, 'id'> as Option);
    setName('');
    setPrice(0);
    setDur(15);
    setStandalone(false);
  }

  return (
    <div style={{ marginTop: 18 }}>
      <h2>オプションマスタ</h2>
      <p className="muted">
        サービスとは別に選べるオプション（料金・追加時間）。予約時はサービス＋オプションの合計時間で枠を確保します。
      </p>
      <form className="opt-form" onSubmit={add}>
        <label>
          オプション名
          <input placeholder="例: 歯磨き / 爪切り" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="opt-form-row2">
          <label>
            料金（¥）
            <input type="number" min={0} step={100} value={price} onChange={(e) => setPrice(Number(e.target.value))} />
          </label>
          <label>
            追加時間（分）
            <input type="number" min={0} step={5} value={dur} onChange={(e) => setDur(Number(e.target.value))} />
          </label>
        </div>
        <label className="inline opt-standalone">
          <input type="checkbox" checked={standalone} onChange={(e) => setStandalone(e.target.checked)} />
          オプションのみ可（予約画面でメニューと同列に表示し、単体でも予約できる）
        </label>
        <button type="submit">オプションを追加</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>名前</th>
              <th>料金</th>
              <th>追加時間</th>
              <th>単体可</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {[...optionItems]
              .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
              .map((o) => (
                <OptionMasterRow key={o.id} tenantId={tenantId} option={o} />
              ))}
            {optionItems.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
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

function OptionMasterRow({ tenantId, option }: { tenantId: string; option: Option }) {
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState(option.price);
  const [dur, setDur] = useState(option.durationMin);

  async function save() {
    await updateDoc(doc(optionsCol(tenantId), option.id), { price, durationMin: dur });
    setEditing(false);
  }

  return (
    <tr>
      <td>{option.name}</td>
      <td>
        {editing ? (
          <input type="number" min={0} step={100} value={price} onChange={(e) => setPrice(Number(e.target.value))} style={{ width: 90 }} />
        ) : (
          `¥${option.price.toLocaleString()}`
        )}
      </td>
      <td>
        {editing ? (
          <>
            +<input type="number" min={0} step={5} value={dur} onChange={(e) => setDur(Number(e.target.value))} style={{ width: 70 }} />分
          </>
        ) : (
          `+${option.durationMin}分`
        )}
      </td>
      <td>
        <button
          type="button"
          className="link-btn"
          title="オプションのみ可（メニューと同列に表示）を切替"
          onClick={() => updateDoc(doc(optionsCol(tenantId), option.id), { standalone: !option.standalone })}
        >
          {option.standalone ? '✓ 可' : '—'}
        </button>
      </td>
      <td>{option.active ? '有効' : '無効'}</td>
      <td>
        {editing ? (
          <>
            <button onClick={save}>保存</button>
            <button onClick={() => setEditing(false)}>取消</button>
          </>
        ) : (
          <>
            <button onClick={() => setEditing(true)}>編集</button>
            <button onClick={() => updateDoc(doc(optionsCol(tenantId), option.id), { active: !option.active })}>
              {option.active ? '無効化' : '有効化'}
            </button>
            <button onClick={() => deleteDoc(doc(optionsCol(tenantId), option.id))}>削除</button>
          </>
        )}
      </td>
    </tr>
  );
}

/** 犬種マスタ: 名前のみ。時間は料金表(犬種×サービス)で決まる。 */
function BreedMaster({ tenantId, breeds }: { tenantId: string; breeds: Breed[] }) {
  const [name, setName] = useState('');

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await addDoc(breedsCol(tenantId), { name: name.trim(), active: true } as Omit<Breed, 'id'> as Breed);
    setName('');
  }

  return (
    <div style={{ marginTop: 18 }}>
      <h2>犬種マスタ</h2>
      <form className="row-form" onSubmit={add}>
        <input placeholder="例: トイプードル" value={name} onChange={(e) => setName(e.target.value)} />
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
            {[...breeds]
              .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
              .map((b) => (
                <tr key={b.id}>
                  <td>{b.name}</td>
                  <td>{b.active ? '有効' : '無効'}</td>
                  <td>
                    <button onClick={() => updateDoc(doc(breedsCol(tenantId), b.id), { active: !b.active })}>
                      {b.active ? '無効化' : '有効化'}
                    </button>
                    <button onClick={() => deleteDoc(doc(breedsCol(tenantId), b.id))}>削除</button>
                  </td>
                </tr>
              ))}
            {breeds.length === 0 && (
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

