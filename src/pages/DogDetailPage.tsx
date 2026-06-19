import { Fragment, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { addDoc, doc, updateDoc } from 'firebase/firestore';
import { ChevronLeft, MessageCircle, Phone } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { breedsCol, customersCol, dogsCol, optionsCol, pricingCol, recordsCol, servicesCol } from '../lib/firestore';
import { useCollection } from '../lib/useCollection';
import { useDocument } from '../lib/useDocument';
import type { Breed, Customer, Dog, Option, PriceEntry, Service, ServiceRecord } from '../lib/types';

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
  const { data: optionItems } = useCollection<Option>(optionsCol(tenantId), [tenantId]);
  const { data: pricing } = useCollection<PriceEntry>(pricingCol(tenantId), [tenantId]);
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
  const [optAdj, setOptAdj] = useState<Record<string, number>>({}); // オプション別の個別追加(超過)時間
  const [optPick, setOptPick] = useState(''); // 追加するオプションの選択
  const [msg, setMsg] = useState<string | null>(null);
  const [cust, setCust] = useState({ ownerName: '', phone: '' });
  const [custMsg, setCustMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!dog) return;
    setForm({ breedId: dog.breedId ?? null, notes: dog.notes ?? '', allergies: dog.allergies ?? '' });
    setAdditionalMin(dog.additionalDurationMin ?? 0);
    setOptAdj(dog.optionAdjustments ?? {});
  }, [dog]);

  useEffect(() => {
    if (customer) setCust({ ownerName: customer.ownerName ?? '', phone: customer.phone ?? '' });
  }, [customer]);

  if (loading) return <p>読み込み中…</p>;
  if (!dog) return <p className="error">カルテが見つかりません。</p>;

  const ceil50 = (n: number) => Math.ceil(n / 50) * 50;
  const cellFor = (svcId: string) =>
    pricing.find((p) => p.breedId === form.breedId && p.serviceId === svcId) ?? null;
  const activeServices = services.filter((s) => s.active);
  // この犬種に料金表があるサービス（時間・料金が割り出せるもの）
  const pricedServices = activeServices.filter((s) => cellFor(s.id));
  // 確定（個別加算込み）。料金は 標準 + 単価×個別加算 を50円切上げ
  const confirmTime = (durationMin: number) => durationMin + additionalMin;
  const confirmPrice = (price: number, durationMin: number) =>
    price + ceil50((durationMin > 0 ? price / durationMin : 0) * additionalMin);
  // オプション: 個別追加時間を設定済み（optAdj にキーがある）ものだけ表示
  const activeOptions = optionItems.filter((o) => o.active);
  const setOptionIds = Object.keys(optAdj);
  const shownOptions = activeOptions.filter((o) => setOptionIds.includes(o.id));
  const addableOptions = activeOptions.filter((o) => !setOptionIds.includes(o.id));

  async function saveDog(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    await updateDoc(doc(dogsCol(tenantId), dogId), {
      breedId: form.breedId ?? null,
      notes: form.notes ?? '',
      allergies: form.allergies ?? '',
      additionalDurationMin: additionalMin,
      optionAdjustments: optAdj,
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
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>作業時間・料金（料金表 犬種×サービス）</legend>
          <label className="inline" htmlFor="addmin">
            個別加算時間（この子だけの上乗せ）
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
          </label>
          {form.breedId == null ? (
            <p className="muted">犬種を選ぶと、サービスごとの時間・料金が表示されます。</p>
          ) : pricedServices.length === 0 ? (
            <p className="muted">この犬種の料金表が未設定です。メニューの料金表で登録してください。</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>サービス</th>
                    <th>標準時間</th>
                    <th>標準料金</th>
                    <th>確定時間</th>
                    <th>確定料金</th>
                  </tr>
                </thead>
                <tbody>
                  {pricedServices.map((s) => {
                    const cell = cellFor(s.id)!;
                    return (
                      <tr key={s.id}>
                        <td>{s.name}</td>
                        <td className="muted">{cell.durationMin}分</td>
                        <td className="muted">¥{cell.price.toLocaleString()}</td>
                        <td>
                          <strong>{confirmTime(cell.durationMin)}分</strong>
                        </td>
                        <td>
                          <strong>¥{confirmPrice(cell.price, cell.durationMin).toLocaleString()}</strong>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </fieldset>

        {activeOptions.length > 0 && (
          <fieldset>
            <legend>オプション超過時間の設定</legend>
            <p className="muted">
              この子だけ余計にかかるオプションを選んで時間を設定。設定したものだけ表示され、未設定は定価扱いです。
            </p>
            {shownOptions.length > 0 && (
              <div className="calc-grid">
                {shownOptions.map((o) => {
                  const add = optAdj[o.id] ?? 0;
                  const unit = o.durationMin > 0 ? o.price / o.durationMin : 0;
                  const effPrice = o.price + ceil50(unit * add);
                  return (
                    <Fragment key={o.id}>
                      <span className="calc-label">
                        {o.name}
                        <span className="muted" style={{ fontWeight: 400 }}>
                          （標準{o.durationMin}分 / ¥{o.price.toLocaleString()}）
                        </span>
                      </span>
                      <span className="calc-val">
                        ＋
                        <input
                          type="number"
                          min={0}
                          step={5}
                          value={add}
                          onChange={(e) => {
                            const v = Math.max(0, Number(e.target.value));
                            setOptAdj((m) => ({ ...m, [o.id]: v }));
                          }}
                          style={{ width: 80 }}
                        />
                        分
                        <span className="muted" style={{ marginLeft: 8 }}>
                          → 合計 {o.durationMin + add}分 / ¥{effPrice.toLocaleString()}
                        </span>
                        <button
                          type="button"
                          className="link-btn"
                          style={{ marginLeft: 10 }}
                          onClick={() => setOptAdj((m) => {
                            const n = { ...m };
                            delete n[o.id];
                            return n;
                          })}
                        >
                          削除
                        </button>
                      </span>
                    </Fragment>
                  );
                })}
              </div>
            )}
            {addableOptions.length > 0 && (
              <div className="row-form" style={{ marginTop: 10 }}>
                <select value={optPick} onChange={(e) => setOptPick(e.target.value)}>
                  <option value="">オプションを選択</option>
                  {addableOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!optPick}
                  onClick={() => {
                    if (!optPick) return;
                    setOptAdj((m) => ({ ...m, [optPick]: 0 }));
                    setOptPick('');
                  }}
                >
                  ＋ 時間設定を追加
                </button>
              </div>
            )}
          </fieldset>
        )}

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
