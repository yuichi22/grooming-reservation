// スタッフ日別シフト管理（シフト①・admin専用）。
// 日ごとに各スタッフの 出勤（営業時間どおり）/ 終日休み / 時間指定（半休・時短）を設定する。
// 空き枠計算はサーバがこの shifts/{date} を参照する。シフトを後から変えても既存予約は
// 動かさず、予約画面に「シフト外」警告バッジを出すだけ（運用で振替）。
import { useMemo, useState } from 'react';
import { deleteField, setDoc } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { shiftDoc, staffCol, tenantDoc } from '../lib/firestore';
import { useCollection } from '../lib/useCollection';
import { useDocument } from '../lib/useDocument';
import { staffHoursFor, type TimeInterval } from '../lib/shifts';
import type { ShiftDayDoc, Staff, Tenant } from '../lib/types';

const DOW = ['日', '月', '火', '水', '木', '金', '土'];

function fmt(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function formatDateJa(ds: string) {
  const [y, m, d] = ds.split('-').map(Number);
  return `${y}年${m}月${d}日（${DOW[new Date(y, m - 1, d).getDay()]}）`;
}

export default function ShiftsPage() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId ?? '__none__';

  const [date, setDate] = useState(() => fmt(new Date()));
  const { data: tenant } = useDocument<Tenant>(tenantDoc(tenantId), [tenantId]);
  const { data: staff } = useCollection<Staff>(staffCol(tenantId), [tenantId]);
  const { data: shiftDay } = useDocument<ShiftDayDoc>(shiftDoc(tenantId, date), [tenantId, date]);
  const [err, setErr] = useState<string | null>(null);

  const businessHours: TimeInterval[] =
    tenant?.settings?.businessHours && tenant.settings.businessHours.length > 0
      ? tenant.settings.businessHours
      : [{ start: '09:00', end: '19:00' }];

  // シフト対象 = 予約枠に入るスタッフ（active かつ 管理者ロール除外。サーバの指名候補と同じ）
  const bookableStaff = useMemo(
    () => staff.filter((s) => s.active && s.role !== 'admin').sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    [staff],
  );

  function shiftDay_(delta: number) {
    const [y, m, d] = date.split('-').map(Number);
    setDate(fmt(new Date(y, m - 1, d + delta)));
  }

  async function apply(staffId: string, intervals: TimeInterval[] | null) {
    setErr(null);
    try {
      // intervals === null は「通常出勤に戻す」= エントリ削除（doc が無くても merge で安全）
      await setDoc(
        shiftDoc(tenantId, date),
        { staff: { [staffId]: intervals === null ? deleteField() : { intervals } } } as never,
        { merge: true },
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存に失敗しました');
    }
  }

  return (
    <section>
      <h1>シフト管理</h1>
      <p className="muted">
        日ごとにスタッフの出勤を設定します。未設定のスタッフは営業時間（
        {businessHours.map((h) => `${h.start}〜${h.end}`).join(' / ')}）どおり出勤の扱いです。
        休み・時間指定は予約の空き枠に即時反映されます（設定済みの予約は動かさず「シフト外」表示のみ）。
      </p>

      <div className="day-nav">
        <div className="day-center">
          <button type="button" onClick={() => shiftDay_(-1)} aria-label="前日">
            ‹
          </button>
          <span className="day-label">{formatDateJa(date)}</span>
          <button type="button" onClick={() => shiftDay_(1)} aria-label="翌日">
            ›
          </button>
        </div>
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
      </div>

      {err && <p className="error">{err}</p>}

      {bookableStaff.length === 0 ? (
        <p className="muted">シフト対象のスタッフがいません（スタッフ管理でトリマーを追加してください）。</p>
      ) : (
        <div className="table-wrap">
          <table className="booking-list">
            <thead>
              <tr>
                <th>スタッフ</th>
                <th>この日の勤務</th>
                <th>変更</th>
              </tr>
            </thead>
            <tbody>
              {bookableStaff.map((s) => (
                <StaffShiftRow
                  key={s.id}
                  staff={s}
                  entry={shiftDay?.staff?.[s.id]}
                  businessHours={businessHours}
                  onApply={(intervals) => apply(s.id, intervals)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StaffShiftRow({
  staff,
  entry,
  businessHours,
  onApply,
}: {
  staff: Staff;
  entry: { intervals?: TimeInterval[] } | undefined;
  businessHours: TimeInterval[];
  onApply: (intervals: TimeInterval[] | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(businessHours[0]?.start ?? '09:00');
  const [end, setEnd] = useState(businessHours[businessHours.length - 1]?.end ?? '19:00');
  const [busy, setBusy] = useState(false);

  const effective = staffHoursFor(entry ? { [staff.id]: entry } : undefined, staff.id, businessHours);
  const label = !entry
    ? '出勤（営業時間どおり）'
    : effective.length === 0
      ? '終日休み'
      : `時間指定 ${effective.map((h) => `${h.start}〜${h.end}`).join(' / ')}`;

  async function run(intervals: TimeInterval[] | null) {
    setBusy(true);
    try {
      await onApply(intervals);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td data-label="スタッフ">{staff.name}</td>
      <td data-label="この日の勤務">
        {entry && effective.length === 0 ? <strong>休</strong> : null} {label}
      </td>
      <td data-label="変更" className="bl-action">
        <div className="row-form" style={{ margin: 0 }}>
          <button type="button" disabled={busy || !entry} onClick={() => run(null)}>
            出勤
          </button>
          <button type="button" disabled={busy || (!!entry && effective.length === 0)} onClick={() => run([])}>
            終日休み
          </button>
          <button type="button" disabled={busy} onClick={() => setEditing((v) => !v)}>
            時間指定
          </button>
        </div>
        {editing && (
          <div className="row-form" style={{ margin: '4px 0 0' }}>
            <input type="time" value={start} step={900} onChange={(e) => setStart(e.target.value)} />
            〜
            <input type="time" value={end} step={900} onChange={(e) => setEnd(e.target.value)} />
            <button type="button" disabled={busy || !start || !end || start >= end} onClick={() => run([{ start, end }])}>
              適用
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}
