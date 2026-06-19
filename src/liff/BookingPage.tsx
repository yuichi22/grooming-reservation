import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getAccessToken, getProfile, initLiff, isDevMode } from './liff';
import {
  createBooking,
  customerSession,
  getAvailability,
  getBookingOptions,
  registerDog,
  type BookingOptions,
} from './customerApi';

type Phase = 'init' | 'needPhone' | 'ready' | 'done' | 'error';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export default function BookingPage() {
  const [params] = useSearchParams();
  const tenantId = params.get('tenant') ?? (import.meta.env.VITE_DEFAULT_TENANT_ID as string) ?? 'groomhaus';

  const [phase, setPhase] = useState<Phase>('init');
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [options, setOptions] = useState<BookingOptions | null>(null);

  // 予約選択
  const [dogId, setDogId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [optionIds, setOptionIds] = useState<string[]>([]);
  const [staffId, setStaffId] = useState(''); // '' = 指名なし (§8)
  const [date, setDate] = useState(todayStr());
  const [slots, setSlots] = useState<string[] | null>(null);
  const [info, setInfo] = useState<{ durationMin: number; price: number | null } | null>(null);
  const [startTime, setStartTime] = useState('');
  const [confirmation, setConfirmation] = useState<{ startTime: string; slotEnd: string } | null>(null);

  async function loadOptions(cid: string) {
    const res = await getBookingOptions({ tenantId, accessToken: getAccessToken(), customerId: cid });
    setOptions(res.data);
  }

  // 初期化: LIFF → プロフィール → セッション(find-or-link §3)
  useEffect(() => {
    (async () => {
      try {
        await initLiff();
        const profile = await getProfile();
        setDisplayName(profile.displayName);
        const res = await customerSession({ tenantId, accessToken: getAccessToken() });
        setCustomerId(res.data.customerId);
        if (res.data.needsPhone) {
          setPhase('needPhone');
        } else {
          // B: customerSession が options も返すので追加呼び出し不要
          if (res.data.options) setOptions(res.data.options);
          else await loadOptions(res.data.customerId);
          setPhase('ready');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : '初期化に失敗しました');
        setPhase('error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitPhone(e: FormEvent) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const phone = (form.elements.namedItem('phone') as HTMLInputElement).value.trim();
    const ownerName = (form.elements.namedItem('ownerName') as HTMLInputElement).value.trim();
    try {
      const res = await customerSession({ tenantId, accessToken: getAccessToken(), phone, ownerName });
      setCustomerId(res.data.customerId);
      if (res.data.options) setOptions(res.data.options);
      else await loadOptions(res.data.customerId);
      setPhase('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : '登録に失敗しました');
    }
  }

  async function addDog(e: FormEvent) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const name = (form.elements.namedItem('dogName') as HTMLInputElement).value.trim();
    const breedId = (form.elements.namedItem('breedId') as HTMLSelectElement).value;
    if (!name) return;
    const res = await registerDog({ tenantId, accessToken: getAccessToken(), customerId, name, breedId: breedId || undefined });
    await loadOptions(customerId);
    setDogId(res.data.dogId);
    form.reset();
  }

  async function fetchSlots() {
    setSlots(null);
    setStartTime('');
    setInfo(null);
    const res = await getAvailability({
      tenantId,
      accessToken: getAccessToken(),
      date,
      serviceId,
      dogId: dogId || undefined,
      staffId: staffId || undefined,
      optionIds,
    });
    setSlots(res.data.slots);
    setInfo({ durationMin: res.data.durationMin, price: res.data.price });
  }

  async function confirm() {
    const res = await createBooking({
      tenantId,
      accessToken: getAccessToken(),
      customerId,
      dogId,
      serviceId,
      date,
      startTime,
      staffId: staffId || undefined,
      optionIds,
    });
    setConfirmation({ startTime, slotEnd: res.data.slotEnd });
    setPhase('done');
  }

  if (phase === 'init') return <Center>読み込み中…</Center>;
  if (phase === 'error') return <Center><p className="error">{error}</p></Center>;

  if (phase === 'needPhone') {
    return (
      <Center>
        <h2>初回登録</h2>
        <p className="muted">ご予約には電話番号の登録が必要です (§3 初回電話番号取得)。</p>
        <form onSubmit={submitPhone}>
          <label>
            お名前
            <input name="ownerName" required />
          </label>
          <label>
            電話番号
            <input name="phone" type="tel" required />
          </label>
          <button type="submit">登録して進む</button>
        </form>
      </Center>
    );
  }

  if (phase === 'done' && confirmation) {
    return (
      <Center>
        <h2>予約が完了しました</h2>
        <p>
          {date} {confirmation.startTime}〜{confirmation.slotEnd}
        </p>
        <p className="muted">前日にLINEでリマインドをお送りします (§9)。</p>
      </Center>
    );
  }

  const selectedDog = options?.dogs.find((d) => d.id === dogId);
  const breedName = (id: string | null) => options?.breeds.find((b) => b.id === id)?.name;
  // 選択中の犬の犬種 × サービス の料金（料金表から）
  const priceFor = (svcId: string) =>
    options?.pricing.find((p) => p.breedId === selectedDog?.breedId && p.serviceId === svcId) ?? null;

  // 合計時間/料金 = 基準(料金表セル + 個別加算) ＋ 選択オプション（個別追加込み）
  // 加算料金 = 単価(標準料金÷標準時間) × 個別追加分 を50円切上げ
  const ceil50 = (n: number) => Math.ceil(n / 50) * 50;
  const allOptions = options?.options ?? [];
  const optAdj = (id: string) => selectedDog?.optionAdjustments?.[id] ?? 0;
  const addMin = selectedDog?.serviceAdjustments?.[serviceId] ?? 0;
  const cell = priceFor(serviceId);
  const baseStdDur = cell?.durationMin ?? null;
  const baseStdAmt = cell?.price ?? null;
  const baseDur = baseStdDur != null ? baseStdDur + addMin : null;
  const baseAmt =
    baseStdAmt != null ? baseStdAmt + ceil50((baseStdDur ? baseStdAmt / baseStdDur : 0) * addMin) : null;
  const optEffDur = (o: { id: string; durationMin: number }) => o.durationMin + optAdj(o.id);
  const optEffAmt = (o: { id: string; price: number; durationMin: number }) =>
    o.price + ceil50((o.durationMin > 0 ? o.price / o.durationMin : 0) * optAdj(o.id));
  const chosenOptions = allOptions.filter((o) => optionIds.includes(o.id));
  const optDur = chosenOptions.reduce((s, o) => s + optEffDur(o), 0);
  const optAmt = chosenOptions.reduce((s, o) => s + optEffAmt(o), 0);
  const estDur = baseDur != null ? baseDur + optDur : null;
  const estAmt = baseAmt != null || optAmt > 0 ? (baseAmt ?? 0) + optAmt : null;
  function toggleOption(id: string) {
    setOptionIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setSlots(null);
    setStartTime('');
  }

  return (
    <Center>
      <h2>{displayName ? `${displayName} さんの予約` : 'ご予約'}</h2>
      {isDevMode && <p className="muted">（開発モード: モックの LINE ユーザで動作中）</p>}

      {(options?.dogs.length ?? 0) === 0 ? (
        <p className="muted">まず予約するワンちゃんを登録してください。</p>
      ) : (
        <label>
          ワンちゃん
          <select value={dogId} onChange={(e) => setDogId(e.target.value)}>
            <option value="">選択してください</option>
            {options?.dogs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {breedName(d.breedId) ? `（${breedName(d.breedId)}）` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      <details open={(options?.dogs.length ?? 0) === 0}>
        <summary className="muted">＋ ワンちゃんを登録</summary>
        <form className="row-form" onSubmit={addDog}>
          <input name="dogName" placeholder="名前" required />
          <select name="breedId" defaultValue="">
            <option value="">犬種を選択</option>
            {options?.breeds.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button type="submit">登録</button>
        </form>
      </details>

      <label>
        メニュー（サービス）
        <select
          value={serviceId}
          onChange={(e) => {
            setServiceId(e.target.value);
            setOptionIds([]);
            setSlots(null);
            setStartTime('');
            setInfo(null);
          }}
        >
          <option value="">選択してください</option>
          {options?.services.map((s) => {
            const cell = priceFor(s.id);
            return (
              <option key={s.id} value={s.id}>
                {s.name}
                {cell ? `（¥${cell.price.toLocaleString()} / ${cell.durationMin}分）` : ''}
              </option>
            );
          })}
        </select>
      </label>
      {selectedDog && serviceId && !priceFor(serviceId) && (
        <p className="muted">
          ※ {breedName(selectedDog.breedId) ?? 'この犬種'} のこのメニューは料金未設定です。店舗にご確認ください。
        </p>
      )}

      {allOptions.length > 0 && (
        <div>
          <label>オプション（複数選択可）</label>
          <div className="opt-list">
            {allOptions.map((o) => (
              <label key={o.id} className="opt-item">
                <input type="checkbox" checked={optionIds.includes(o.id)} onChange={() => toggleOption(o.id)} />
                {o.name}
                <span className="opt-meta">
                  +¥{optEffAmt(o).toLocaleString()} / +{optEffDur(o)}分
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
      {serviceId && estDur != null && (
        <div className="est-total">
          合計 {estDur}分{estAmt != null ? ` / ¥${estAmt.toLocaleString()}` : ''}
          <span className="muted" style={{ fontWeight: 400, display: 'block' }}>
            （基準 {baseDur ?? '—'}分 ＋ オプション {optDur}分）
          </span>
        </div>
      )}

      <label>
        指名（任意 §8）
        <select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          <option value="">指名なし（空いているスタッフ）</option>
          {options?.staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <label className="inline">
        日付
        <input type="date" value={date} min={todayStr()} onChange={(e) => setDate(e.target.value)} />
      </label>

      <div style={{ marginTop: 12 }}>
        <button type="button" onClick={fetchSlots} disabled={!serviceId || !dogId}>
          空き時間を見る
        </button>
        {info && (
          <span className="muted" style={{ marginLeft: 8 }}>
            所要 {info.durationMin}分{info.price != null ? ` / ¥${info.price.toLocaleString()}` : ''}
          </span>
        )}
      </div>

      {slots && (
        <div style={{ marginTop: 12 }}>
          {slots.length === 0 ? (
            <p className="muted">この日に空きはありません。</p>
          ) : (
            <div className="slot-grid">
              {slots.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStartTime(s)}
                  className={startTime === s ? 'slot selected' : 'slot'}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {startTime && (
        <div style={{ marginTop: 16 }}>
          <button type="button" onClick={confirm} disabled={!dogId}>
            {date} {startTime} で予約する
          </button>
          {!dogId && <span className="error" style={{ marginLeft: 8 }}>ワンちゃんを選択してください</span>}
        </div>
      )}
    </Center>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="liff-shell">{children}</div>;
}
