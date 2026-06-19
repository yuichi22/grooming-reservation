import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { addDoc, doc, updateDoc } from 'firebase/firestore';
import { ChevronLeft, MessageCircle, Phone } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { breedsCol, customersCol, dogsCol, recordsCol, servicesCol } from '../lib/firestore';
import { useCollection } from '../lib/useCollection';
import { useDocument } from '../lib/useDocument';
import type { Breed, Customer, Dog, Service, ServiceRecord } from '../lib/types';

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
  const customerId = dog?.customerId || '__none__';
  const { data: customer } = useDocument<Customer>(doc(customersCol(tenantId), customerId), [tenantId, customerId]);
  const { data: customers } = useCollection<Customer>(customersCol(tenantId), [tenantId]);

  const [form, setForm] = useState<{ breedId: string | null; notes: string; allergies: string }>({
    breedId: null,
    notes: '',
    allergies: '',
  });
  const [additionalMin, setAdditionalMin] = useState(0);
  const [basePrice, setBasePrice] = useState(0);
  const [chargeAuto, setChargeAuto] = useState(true); // 加算料金を自動計算に追従させるか
  const [chargeManual, setChargeManual] = useState(0); // 手入力した加算料金
  const [msg, setMsg] = useState<string | null>(null);
  const [cust, setCust] = useState({ ownerName: '', phone: '' });
  const [custMsg, setCustMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!dog) return;
    setForm({ breedId: dog.breedId ?? null, notes: dog.notes ?? '', allergies: dog.allergies ?? '' });
    const base = dog.basePrice ?? dog.confirmedPrice ?? 0;
    setBasePrice(base);
    setAdditionalMin(dog.additionalDurationMin ?? 0);
    // 既に basePrice を保存済みなら、保存時の確定料金を保持（手入力扱い）。新規は自動。
    setChargeAuto(dog.basePrice == null);
    setChargeManual(Math.max(0, (dog.confirmedPrice ?? base) - base));
  }, [dog]);

  useEffect(() => {
    if (customer) setCust({ ownerName: customer.ownerName ?? '', phone: customer.phone ?? '' });
  }, [customer]);

  if (loading) return <p>読み込み中…</p>;
  if (!dog) return <p className="error">カルテが見つかりません。</p>;

  const ceil50 = (n: number) => Math.ceil(n / 50) * 50;
  const selectedBreed = breeds.find((b) => b.id === form.breedId);
  const standardMin = selectedBreed?.standardDurationMin ?? 0;
  const totalMin = standardMin + additionalMin;
  const unitPerMin = standardMin > 0 ? basePrice / standardMin : 0;
  const autoCharge = standardMin > 0 ? ceil50(unitPerMin * additionalMin) : 0;
  const effectiveCharge = chargeAuto ? autoCharge : chargeManual;
  const totalPrice = basePrice + effectiveCharge;

  async function saveDog(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    await updateDoc(doc(dogsCol(tenantId), dogId), {
      breedId: form.breedId ?? null,
      notes: form.notes ?? '',
      allergies: form.allergies ?? '',
      additionalDurationMin: additionalMin,
      basePrice,
      confirmedDurationMin: totalMin > 0 ? totalMin : null,
      confirmedPrice: totalPrice > 0 ? totalPrice : null,
    });
    setMsg('保存しました');
  }

  async function saveCustomer() {
    if (!dog?.customerId) return;
    setCustMsg(null);
    await updateDoc(doc(customersCol(tenantId), dog.customerId), {
      ownerName: cust.ownerName.trim(),
      phone: cust.phone.trim() || null,
    });
    setCustMsg('保存しました');
  }

  const lineLinked = !!customer?.lineUserId;

  return (
    <section>
      <div className="detail-head">
        <Link to="/karte" className="back-btn" aria-label="カルテ一覧へ戻る">
          <ChevronLeft size={22} strokeWidth={2.25} />
        </Link>
        <h1>{dog.name}</h1>
      </div>

      {dog.customerId ? (
        <div className="customer-card">
          <input
            value={cust.ownerName}
            placeholder="飼い主名"
            onChange={(e) => setCust((c) => ({ ...c, ownerName: e.target.value }))}
            style={{ flex: '1 1 140px', fontWeight: 700 }}
          />
          <input
            value={cust.phone}
            type="tel"
            placeholder="電話番号"
            onChange={(e) => setCust((c) => ({ ...c, phone: e.target.value }))}
            style={{ flex: '1 1 140px' }}
          />
          <span className={`line-badge ${lineLinked ? 'linked' : 'unlinked'}`}>
            {lineLinked ? 'LINE連携済み' : 'LINE未連携'}
          </span>
          <div className="customer-actions">
            <button type="button" onClick={saveCustomer}>
              顧客情報を保存
            </button>
            {cust.phone.trim() && (
              <a className="tel-btn" href={`tel:${cust.phone.trim()}`}>
                <Phone size={16} /> 電話
              </a>
            )}
            <a className="line-btn" href="https://line.me/R/nv/chat" target="_blank" rel="noopener noreferrer">
              <MessageCircle size={16} /> LINEで連絡
            </a>
          </div>
          {custMsg && <span className="muted" style={{ flexBasis: '100%' }}>{custMsg}</span>}
          {!lineLinked && (
            <span className="muted" style={{ flexBasis: '100%' }}>
              この電話番号で LINE 登録されると、自動でこの犬が紐づきます（§3）。
            </span>
          )}
        </div>
      ) : (
        <AttachCustomer tenantId={tenantId} dogId={dogId} customers={customers} />
      )}

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
                {b.standardDurationMin != null ? `（標準${b.standardDurationMin}分）` : ''}
              </option>
            ))}
          </select>
        </label>

        <fieldset>
          <legend>作業時間（§6 カレンダー占有 / §7）</legend>
          <div className="calc-grid">
            <span className="calc-label">標準作業時間（犬種）</span>
            <span className="calc-val">
              {standardMin > 0 ? `${standardMin}分` : <span className="muted">犬種マスタに未設定</span>}
            </span>

            <label className="calc-label" htmlFor="addmin">個別加算時間</label>
            <span className="calc-val">
              ＋
              <input
                id="addmin"
                type="number"
                min={0}
                step={5}
                value={additionalMin}
                onChange={(e) => setAdditionalMin(Math.max(0, Number(e.target.value)))}
                style={{ width: 80 }}
              />
              分
            </span>

            <span className="calc-label">確定作業時間</span>
            <span className="calc-val calc-total">{totalMin > 0 ? `${totalMin}分` : '未確定'}</span>
          </div>
        </fieldset>

        <fieldset>
          <legend>料金</legend>
          <div className="calc-grid">
            <label className="calc-label" htmlFor="baseprice">基本料金</label>
            <span className="calc-val">
              ¥
              <input
                id="baseprice"
                type="number"
                min={0}
                step={100}
                value={basePrice}
                onChange={(e) => setBasePrice(Math.max(0, Number(e.target.value)))}
                style={{ width: 110 }}
              />
            </span>

            <span className="calc-label">
              加算料金
              <span className="muted" style={{ fontWeight: 400 }}>
                {standardMin > 0
                  ? `（単価¥${Math.round(unitPerMin).toLocaleString()}/分 × ${additionalMin}分 → 50円切上 ¥${autoCharge.toLocaleString()}）`
                  : '（犬種の標準時間が必要）'}
              </span>
            </span>
            <span className="calc-val">
              ¥
              <input
                type="number"
                min={0}
                step={50}
                value={effectiveCharge}
                onChange={(e) => {
                  setChargeManual(Math.max(0, Number(e.target.value)));
                  setChargeAuto(false);
                }}
                style={{ width: 110 }}
              />
              {!chargeAuto && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setChargeAuto(true)}
                  style={{ marginLeft: 8 }}
                >
                  自動計算に戻す
                </button>
              )}
            </span>

            <span className="calc-label">確定料金</span>
            <span className="calc-val calc-total">¥{totalPrice.toLocaleString()}</span>
          </div>
        </fieldset>

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

/** 顧客未登録の犬（店頭でカルテ先行作成・旧データ等）に飼い主を紐づける。 */
function AttachCustomer({
  tenantId,
  dogId,
  customers,
}: {
  tenantId: string;
  dogId: string;
  customers: Customer[];
}) {
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [ownerName, setOwnerName] = useState('');
  const [phone, setPhone] = useState('');
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);

  const active = customers.filter((c) => !c.mergedInto);

  async function attach(customerId: string) {
    await updateDoc(doc(dogsCol(tenantId), dogId), { customerId });
  }

  async function createAndAttach() {
    if (busy) return;
    setBusy(true);
    try {
      const trimmedPhone = phone.trim();
      let customerId = '';
      if (trimmedPhone) {
        const ex = active.find((c) => c.phone === trimmedPhone); // 同番号があれば再利用
        if (ex) customerId = ex.id;
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
      await attach(customerId);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="customer-card" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <strong>顧客が未登録です</strong>
      <span className="muted">
        飼い主を登録/紐づけると、同じ電話番号で LINE 登録したとき自動で連携されます（§3）。
      </span>
      <div className="tabs" style={{ margin: '6px 0' }}>
        <button type="button" className={`tab${mode === 'new' ? ' active' : ''}`} onClick={() => setMode('new')}>
          新規作成
        </button>
        <button
          type="button"
          className={`tab${mode === 'existing' ? ' active' : ''}`}
          onClick={() => setMode('existing')}
        >
          既存から選択
        </button>
      </div>
      {mode === 'new' ? (
        <div className="row-form" style={{ margin: 0 }}>
          <input placeholder="飼い主名" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
          <input placeholder="電話番号" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button
            type="button"
            onClick={createAndAttach}
            disabled={busy || (!ownerName.trim() && !phone.trim())}
          >
            {busy ? '登録中…' : '登録して紐づけ'}
          </button>
        </div>
      ) : (
        <div className="row-form" style={{ margin: 0 }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">顧客を選択</option>
            {active.map((c) => (
              <option key={c.id} value={c.id}>
                {c.ownerName || '(名前なし)'}
                {c.phone ? ` / ${c.phone}` : ''}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => pick && attach(pick)} disabled={!pick || busy}>
            この顧客に紐づけ
          </button>
        </div>
      )}
    </div>
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
