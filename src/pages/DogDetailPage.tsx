import { Fragment, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { addDoc, deleteDoc, doc, query, updateDoc, where } from 'firebase/firestore';
import { Archive, ArchiveRestore, ChevronLeft, MessageCircle, Pencil, Phone, Trash2 } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import AdjStepper from '../components/AdjStepper';
import { actualMin, adjustedPrice, customerMin } from '../lib/adjust';
import {
  bookingsCol,
  breedsCol,
  customersCol,
  dogsCol,
  optionsCol,
  pricingCol,
  recordsCol,
  servicesCol,
} from '../lib/firestore';
import { useCollection } from '../lib/useCollection';
import { useDocument } from '../lib/useDocument';
import { hasKanji } from './KartePage';
import type { Booking, Breed, Customer, Dog, Option, PriceEntry, Service, ServiceRecord } from '../lib/types';

/** 順序非依存で number マップを比較。 */
function sameMap(a: Record<string, number>, b: Record<string, number>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => a[k] === b[k]);
}
/** 0 のエントリを除いたマップ（サービス別加算は 0 を未設定とみなす）。 */
function nonZero(m: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== 0));
}

export default function DogDetailPage() {
  const { claims } = useAuth();
  const { dogId } = useParams<{ dogId: string }>();
  const tenantId = claims.tenantId;
  if (!tenantId) return <p className="error">テナントが割り当てられていません。</p>;
  if (!dogId) return <p className="error">犬が指定されていません。</p>;
  return <DogDetailInner tenantId={tenantId} dogId={dogId} />;
}

function DogDetailInner({ tenantId, dogId }: { tenantId: string; dogId: string }) {
  const navigate = useNavigate();
  const { data: dog, loading } = useDocument<Dog>(doc(dogsCol(tenantId), dogId), [tenantId, dogId]);
  const { data: records } = useCollection<ServiceRecord>(recordsCol(tenantId, dogId), [tenantId, dogId]);
  // 削除の可否判定に使う。履歴が無くても予約が残っていれば消せない（予約側が名前を引けなくなる）
  const { data: dogBookings } = useCollection<Booking>(
    query(bookingsCol(tenantId), where('dogId', '==', dogId)),
    [tenantId, dogId],
  );
  const { data: breeds } = useCollection<Breed>(breedsCol(tenantId), [tenantId]);
  const { data: services } = useCollection<Service>(servicesCol(tenantId), [tenantId]);
  const { data: optionItems } = useCollection<Option>(optionsCol(tenantId), [tenantId]);
  const { data: pricing } = useCollection<PriceEntry>(pricingCol(tenantId), [tenantId]);
  const serviceName = useMemo(() => new Map(services.map((s) => [s.id, s.name])), [services]);
  const customerId = dog?.customerId || '__none__';
  const { data: customer } = useDocument<Customer>(doc(customersCol(tenantId), customerId), [tenantId, customerId]);
  const { data: customers } = useCollection<Customer>(customersCol(tenantId), [tenantId]);

  const [form, setForm] = useState<{ name: string; nameKana: string; breedId: string | null; notes: string; allergies: string }>({
    name: '',
    nameKana: '',
    breedId: null,
    notes: '',
    allergies: '',
  });
  const [editingName, setEditingName] = useState(false);
  const [serviceAdj, setServiceAdj] = useState<Record<string, number>>({}); // サービス別の個別加算時間
  const [optAdj, setOptAdj] = useState<Record<string, number>>({}); // オプション別の個別追加(超過)時間
  const [optPick, setOptPick] = useState(''); // 追加するオプションの選択
  const [msg, setMsg] = useState<string | null>(null);
  const [cust, setCust] = useState({ ownerName: '', phone: '' });
  const [custMsg, setCustMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!dog) return;
    setForm({
      name: dog.name ?? '',
      nameKana: dog.nameKana ?? '',
      breedId: dog.breedId ?? null,
      notes: dog.notes ?? '',
      allergies: dog.allergies ?? '',
    });
    setServiceAdj(dog.serviceAdjustments ?? {});
    setOptAdj(dog.optionAdjustments ?? {});
  }, [dog]);

  useEffect(() => {
    if (customer) setCust({ ownerName: customer.ownerName ?? '', phone: customer.phone ?? '' });
  }, [customer]);

  if (loading) return <p>読み込み中…</p>;
  if (!dog) return <p className="error">カルテが見つかりません。</p>;

  const cellFor = (svcId: string) =>
    pricing.find((p) => p.breedId === form.breedId && p.serviceId === svcId) ?? null;
  const activeServices = services.filter((s) => s.active);
  // この犬種に料金表があるサービス（時間・料金が割り出せるもの）
  const pricedServices = activeServices.filter((s) => cellFor(s.id));
  // 確定（サービス別個別加算込み）。計算規則は lib/adjust.ts に集約
  const adjFor = (svcId: string) => serviceAdj[svcId] ?? 0;
  // オプション: 個別追加時間を設定済み（optAdj にキーがある）ものだけ表示
  const activeOptions = optionItems.filter((o) => o.active);
  const setOptionIds = Object.keys(optAdj);
  const shownOptions = activeOptions.filter((o) => setOptionIds.includes(o.id));
  const addableOptions = activeOptions.filter((o) => !setOptionIds.includes(o.id));

  // 漢字名はふりがな必須（五十音索引のため）
  const displayName = form.name.trim() || dog.name;
  const needsKana = hasKanji(displayName) && !form.nameKana.trim();

  // 編集あり（保存済みの値と差分があるか）
  const dirty =
    form.name.trim() !== (dog.name ?? '') ||
    form.nameKana.trim() !== (dog.nameKana ?? '') ||
    (form.breedId ?? null) !== (dog.breedId ?? null) ||
    (form.notes ?? '') !== (dog.notes ?? '') ||
    (form.allergies ?? '') !== (dog.allergies ?? '') ||
    !sameMap(nonZero(serviceAdj), nonZero(dog.serviceAdjustments ?? {})) ||
    !sameMap(optAdj, dog.optionAdjustments ?? {});

  function cancelEdit() {
    setForm({
      name: dog?.name ?? '',
      nameKana: dog?.nameKana ?? '',
      breedId: dog?.breedId ?? null,
      notes: dog?.notes ?? '',
      allergies: dog?.allergies ?? '',
    });
    setServiceAdj(dog?.serviceAdjustments ?? {});
    setOptAdj(dog?.optionAdjustments ?? {});
    setEditingName(false);
    setMsg(null);
  }

  async function saveDog() {
    setMsg(null);
    const finalName = form.name.trim() || dog?.name || '';
    if (hasKanji(finalName) && !form.nameKana.trim()) {
      setMsg('漢字名はふりがなを入力してください');
      return;
    }
    await updateDoc(doc(dogsCol(tenantId), dogId), {
      // 名前が空になるのは事故なので、空欄なら元の名前を維持する
      name: finalName,
      nameKana: form.nameKana.trim() || null,
      breedId: form.breedId ?? null,
      notes: form.notes ?? '',
      allergies: form.allergies ?? '',
      serviceAdjustments: nonZero(serviceAdj),
      // ⚠ こちらは 0 も残す。キーの有無が「この子に設定した行」の一覧を兼ねているため、
      //   0 を捨てると追加した行が保存のたびに消える
      optionAdjustments: optAdj,
    });
    setEditingName(false);
    setMsg('保存しました');
  }

  // ---- カルテの削除 / アーカイブ ----
  // 履歴（施術記録）は過去の売上・作業の記録なので消さない。履歴がある子はアーカイブに送る。
  // 予約が残っている子も、予約側から名前が引けなくなるため削除させない。
  const canDelete = records.length === 0 && dogBookings.length === 0;
  const archived = !!dog.archivedAt;

  async function onDelete() {
    if (!canDelete) return;
    if (!confirm(`「${dog?.name}」のカルテを削除します。元に戻せません。よろしいですか？`)) return;
    await deleteDoc(doc(dogsCol(tenantId), dogId));
    navigate('/karte');
  }

  async function onArchive() {
    await updateDoc(doc(dogsCol(tenantId), dogId), { archivedAt: new Date().toISOString() });
    setMsg('アーカイブしました');
  }

  async function onUnarchive() {
    await updateDoc(doc(dogsCol(tenantId), dogId), { archivedAt: null });
    setMsg('アーカイブから戻しました');
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
        {editingName ? (
          <span className="name-edit">
            <input
              value={form.name}
              autoFocus
              aria-label="犬の名前"
              placeholder="犬の名前"
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  setEditingName(false);
                } else if (e.key === 'Escape') {
                  setForm((f) => ({ ...f, name: dog?.name ?? '' }));
                  setEditingName(false);
                }
              }}
            />
          </span>
        ) : (
          <span className="name-edit">
            <h1>{form.name || dog.name}</h1>
            <button type="button" className="icon-btn" aria-label="名前を編集" onClick={() => setEditingName(true)}>
              <Pencil size={15} />
            </button>
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {!dirty && msg && <span className="muted">{msg}</span>}
          {dirty && (
            <button type="button" onClick={cancelEdit}>
              キャンセル
            </button>
          )}
          <button type="button" className={dirty ? 'btn-primary' : ''} disabled={!dirty || needsKana} onClick={saveDog}>
            保存
          </button>
        </div>
      </div>

      {hasKanji(displayName) && (
        <label className="kana-field">
          ふりがな（漢字名は必須）
          <input
            value={form.nameKana}
            placeholder="例: そら"
            onChange={(e) => setForm((f) => ({ ...f, nameKana: e.target.value }))}
          />
          {needsKana && <span className="error"> ふりがなを入力してください</span>}
        </label>
      )}

      {archived && (
        <div className="archived-banner">
          <Archive size={16} />
          <span style={{ flex: '1 1 200px' }}>
            このカルテはアーカイブ済みです。一覧の既定表示には出ません。
          </span>
          <button type="button" onClick={onUnarchive}>
            <ArchiveRestore size={15} style={{ marginRight: 6, verticalAlign: '-2px' }} />
            アーカイブから戻す
          </button>
        </div>
      )}

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
              この電話番号で LINE 登録されると、自動でこの犬が紐づきます。
            </span>
          )}
        </div>
      ) : (
        <AttachCustomer tenantId={tenantId} dogId={dogId} customers={customers} />
      )}

      <form onSubmit={(e) => { e.preventDefault(); saveDog(); }}>
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
          <p className="muted">
            この子だけ標準と違う分を、サービスごとに設定できます。<strong>早く仕上がる子はマイナス</strong>にしてください。
            マイナスにすると予約枠はその分だけ短く取りますが、<strong>お客様には標準時間のままお伝えします</strong>
            （早い仕上がりを約束しないため）。料金も下がりません。
          </p>
          {form.breedId == null ? (
            <p className="muted">犬種を選ぶと、サービスごとの時間・料金が表示されます。</p>
          ) : pricedServices.length === 0 ? (
            <p className="muted">この犬種の料金表が未設定です。メニューの料金表で登録してください。</p>
          ) : (
            <div className="table-wrap">
              <table className="karte-time-table">
                <thead>
                  <tr>
                    <th>サービス</th>
                    <th>標準時間</th>
                    <th>標準料金</th>
                    <th>個別加算</th>
                    <th>確定時間</th>
                    <th>確定料金</th>
                  </tr>
                </thead>
                <tbody>
                  {pricedServices.map((s) => {
                    const cell = cellFor(s.id)!;
                    const adj = adjFor(s.id);
                    const shown = customerMin(cell.durationMin, adj);
                    const actual = actualMin(cell.durationMin, adj);
                    return (
                      <tr key={s.id}>
                        <td data-label="サービス" className="kt-name">{s.name}</td>
                        <td data-label="標準時間" className="muted">{cell.durationMin}分</td>
                        <td data-label="標準料金" className="muted">¥{cell.price.toLocaleString()}</td>
                        <td data-label="個別加算" className="kt-adj">
                          <AdjStepper
                            value={adj}
                            stdMin={cell.durationMin}
                            onChange={(v) => setServiceAdj((m) => ({ ...m, [s.id]: v }))}
                          />
                        </td>
                        <td data-label="確定時間">
                          <strong>{actual}分</strong>
                          {/* 確定時間とお客様への案内がずれるのはマイナスのときだけ。ずれる時だけ書く */}
                          {shown !== actual && <span className="kt-sub">お客様には{shown}分</span>}
                        </td>
                        <td data-label="確定料金">
                          <strong>¥{adjustedPrice(cell.price, cell.durationMin, adj).toLocaleString()}</strong>
                          {adj < 0 && <span className="kt-sub">短縮では下げません</span>}
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
            <legend>オプションの個別時間の設定</legend>
            <p className="muted">
              この子だけ標準と違うオプションを選んで時間を設定。設定したものだけ表示され、未設定は定価扱いです。
              サービスと同じく<strong>マイナスも設定できます</strong>。
            </p>
            {shownOptions.length > 0 && (
              <div className="calc-grid">
                {shownOptions.map((o) => {
                  const add = optAdj[o.id] ?? 0;
                  const shown = customerMin(o.durationMin, add);
                  const actual = actualMin(o.durationMin, add);
                  return (
                    <Fragment key={o.id}>
                      <span className="calc-label">
                        {o.name}
                        <span className="muted" style={{ fontWeight: 400 }}>
                          （標準{o.durationMin}分 / ¥{o.price.toLocaleString()}）
                        </span>
                      </span>
                      <span className="calc-val">
                        <AdjStepper
                          value={add}
                          stdMin={o.durationMin}
                          onChange={(v) => setOptAdj((m) => ({ ...m, [o.id]: v }))}
                        />
                        <span className="muted" style={{ marginLeft: 8 }}>
                          → 合計 {actual}分 / ¥{adjustedPrice(o.price, o.durationMin, add).toLocaleString()}
                          {shown !== actual && `（お客様には${shown}分）`}
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
        {/* 保存ボタンはヘッダー上部に移動 */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
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

      {/* 施術履歴の有無で出し分ける。履歴があるカルテは消さずアーカイブへ。 */}
      <div className="karte-danger">
        {canDelete ? (
          <>
            <p className="muted">
              施術履歴も予約もないカルテです。誤って作った場合は削除できます。元に戻せません。
            </p>
            <button type="button" className="btn-danger" onClick={onDelete}>
              <Trash2 size={15} style={{ marginRight: 6, verticalAlign: '-2px' }} />
              このカルテを削除
            </button>
          </>
        ) : archived ? (
          <>
            <p className="muted">アーカイブ済みです。一覧に戻したいときは上のバナーから戻せます。</p>
            <button type="button" onClick={onUnarchive}>
              <ArchiveRestore size={15} style={{ marginRight: 6, verticalAlign: '-2px' }} />
              アーカイブから戻す
            </button>
          </>
        ) : (
          <>
            <p className="muted">
              {records.length > 0
                ? `施術履歴が${records.length}件あるため削除できません。`
                : `この子の予約が${dogBookings.length}件あるため削除できません。`}
              来店されなくなった場合はアーカイブすると、一覧から隠れます（データは残ります）。
            </p>
            <button type="button" onClick={onArchive}>
              <Archive size={15} style={{ marginRight: 6, verticalAlign: '-2px' }} />
              アーカイブする
            </button>
          </>
        )}
      </div>
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
        飼い主を登録/紐づけると、同じ電話番号で LINE 登録したとき自動で連携されます。
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
