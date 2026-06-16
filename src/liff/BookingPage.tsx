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
  const [menuId, setMenuId] = useState('');
  const [staffId, setStaffId] = useState(''); // '' = 指名なし (§8)
  const [date, setDate] = useState(todayStr());
  const [slots, setSlots] = useState<string[] | null>(null);
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
          await loadOptions(res.data.customerId);
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
      await loadOptions(res.data.customerId);
      setPhase('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : '登録に失敗しました');
    }
  }

  async function addDog(e: FormEvent) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const name = (form.elements.namedItem('dogName') as HTMLInputElement).value.trim();
    const breed = (form.elements.namedItem('breed') as HTMLInputElement).value.trim();
    if (!name) return;
    const res = await registerDog({ tenantId, accessToken: getAccessToken(), customerId, name, breed });
    await loadOptions(customerId);
    setDogId(res.data.dogId);
    form.reset();
  }

  async function fetchSlots() {
    setSlots(null);
    setStartTime('');
    const res = await getAvailability({
      tenantId,
      accessToken: getAccessToken(),
      date,
      menuId,
      dogId: dogId || undefined,
      staffId: staffId || undefined,
    });
    setSlots(res.data.slots);
  }

  async function confirm() {
    const res = await createBooking({
      tenantId,
      accessToken: getAccessToken(),
      customerId,
      dogId,
      menuId,
      date,
      startTime,
      staffId: staffId || undefined,
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

  const selectedMenu = options?.menus.find((m) => m.id === menuId);

  return (
    <Center>
      <h2>{displayName ? `${displayName} さんの予約` : 'ご予約'}</h2>
      {isDevMode && <p className="muted">（開発モード: モックの LINE ユーザで動作中）</p>}

      <label>
        ワンちゃん
        <select value={dogId} onChange={(e) => setDogId(e.target.value)}>
          <option value="">選択してください</option>
          {options?.dogs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.confirmedDurationMin != null ? `（確定 ${d.confirmedDurationMin}分）` : '（初回）'}
            </option>
          ))}
        </select>
      </label>
      <details>
        <summary className="muted">ワンちゃんを登録</summary>
        <form className="row-form" onSubmit={addDog}>
          <input name="dogName" placeholder="名前" />
          <input name="breed" placeholder="犬種" />
          <button type="submit">登録</button>
        </form>
      </details>

      <label>
        メニュー
        <select value={menuId} onChange={(e) => setMenuId(e.target.value)}>
          <option value="">選択してください</option>
          {options?.menus.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}（¥{m.price.toLocaleString()}
              {m.fixedDuration ? ' / 固定時間' : ''}）
            </option>
          ))}
        </select>
      </label>

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
        <button type="button" onClick={fetchSlots} disabled={!menuId}>
          空き時間を見る
        </button>
        {selectedMenu?.fixedDuration && (
          <span className="muted" style={{ marginLeft: 8 }}>
            固定時間メニュー（{selectedMenu.defaultDurationMin}分）
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
