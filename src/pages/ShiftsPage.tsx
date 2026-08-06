// スタッフ日別シフト管理（シフト①UI改良版・admin専用）。
// - 月ごとの横スクロール表（行=スタッフ×列=日）を「今月〜Nヶ月先」まで縦に並べる
// - セルは 出勤/休み/時間 の縦ボタン。出勤・休みはタップで即確定して色付きチップになり、
//   チップを再タップすると選択中を強調した状態で選び直せる。時間のみモーダル（決定/キャンセル）
// - 先頭の「範囲」セレクタ = tenants.settings.bookingHorizonMonths。
//   お客様のWeb予約カレンダーの表示・受付範囲もこの設定に連動する（サーバ側で強制）
import { useMemo, useState } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { deleteDoc, doc, documentId, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { db } from '../firebaseStaff';
import { useAuth } from '../auth/AuthContext';
import { closuresCol, shiftDoc, shiftsCol, staffCol, tenantDoc } from '../lib/firestore';
import { useCollection } from '../lib/useCollection';
import { useDocument } from '../lib/useDocument';
import type { TimeInterval } from '../lib/shifts';
import type { Closure, ShiftDayDoc, Staff, Tenant } from '../lib/types';

const DOW = ['日', '月', '火', '水', '木', '金', '土'];

function fmt(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type ShiftEntry = NonNullable<ShiftDayDoc['staff']>[string];
type CellStatus = 'unset' | 'work' | 'off' | 'custom';

function entryStatus(entry: ShiftEntry | undefined): CellStatus {
  if (!entry) return 'unset';
  if (entry.work === true) return 'work';
  const iv = Array.isArray(entry.intervals) ? entry.intervals : [];
  return iv.length === 0 ? 'off' : 'custom';
}

export default function ShiftsPage() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId ?? '__none__';

  const { data: tenant } = useDocument<Tenant>(tenantDoc(tenantId), [tenantId]);
  const { data: staff } = useCollection<Staff>(staffCol(tenantId), [tenantId]);
  const { data: closures } = useCollection<Closure>(closuresCol(tenantId), [tenantId]);
  const [err, setErr] = useState<string | null>(null);

  const horizonMonths = tenant?.settings?.bookingHorizonMonths ?? 3;
  const businessHours: TimeInterval[] =
    tenant?.settings?.businessHours && tenant.settings.businessHours.length > 0
      ? tenant.settings.businessHours
      : [{ start: '09:00', end: '19:00' }];

  const today = fmt(new Date());
  // 今月〜horizonMonthsヶ月先までの月リスト（8月にN=4なら 8,9,10,11,12月）
  const months = useMemo(() => {
    const now = new Date();
    return Array.from({ length: horizonMonths + 1 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  }, [horizonMonths]);
  const rangeFrom = fmt(new Date(months[0].y, months[0].m, 1));
  const rangeTo = fmt(new Date(months[months.length - 1].y, months[months.length - 1].m + 1, 0));

  // 表示範囲のシフトdocをまとめて購読（doc ID = 日付なので ID 範囲クエリ）
  const { data: shiftDays } = useCollection<ShiftDayDoc>(
    query(shiftsCol(tenantId), where(documentId(), '>=', rangeFrom), where(documentId(), '<=', rangeTo)),
    [tenantId, rangeFrom, rangeTo],
  );
  const shiftByDate = useMemo(() => new Map(shiftDays.map((s) => [s.id, s])), [shiftDays]);
  const closedDates = useMemo(
    () => new Set(closures.filter((c) => c.fullDay !== false).map((c) => c.id)),
    [closures],
  );

  const bookableStaff = useMemo(
    () => staff.filter((s) => s.active && s.role !== 'admin').sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    [staff],
  );

  // 設定モーダル（範囲・自動休業。説明もここに集約）
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 選び直し中のセルと、時間指定モーダル
  const [editing, setEditing] = useState<{ date: string; staffId: string } | null>(null);
  const [timeModal, setTimeModal] = useState<{ date: string; staffId: string; staffName: string; start: string; end: string } | null>(null);
  // 休業日（closures）の設定モーダル。日付ヘッダーのタップで開く（設定ページから移設・集約）
  const [closureModal, setClosureModal] = useState<{ date: string; isClosed: boolean; reason: string } | null>(null);

  async function saveClosure(date: string, close: boolean, reason: string) {
    setErr(null);
    try {
      const ref = doc(closuresCol(tenantId), date);
      if (close) {
        // 注: undefined フィールドは Firestore が拒否するため、理由は空なら載せない
        await setDoc(ref, { ...(reason.trim() ? { reason: reason.trim() } : {}), fullDay: true } as never);
      } else {
        await deleteDoc(ref);
      }
      setClosureModal(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '休業日の保存に失敗しました');
    }
  }

  async function writeEntry(date: string, staffId: string, entry: { work: true } | { intervals: TimeInterval[] }) {
    setErr(null);
    try {
      // mergeFields でそのスタッフのエントリだけ丸ごと差し替える（work⇄intervalsの残骸を残さない）
      await setDoc(shiftDoc(tenantId, date), { staff: { [staffId]: entry } } as never, {
        mergeFields: [`staff.${staffId}`],
      });
      setEditing(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存に失敗しました');
    }
  }

  async function saveHorizon(n: number) {
    setErr(null);
    try {
      await updateDoc(doc(db, 'tenants', tenantId), { 'settings.bookingHorizonMonths': n });
    } catch (e) {
      setErr(e instanceof Error ? e.message : '設定の保存に失敗しました');
    }
  }

  const autoClose = tenant?.settings?.autoCloseWhenAllOff ?? true;
  async function saveAutoClose(on: boolean) {
    setErr(null);
    try {
      await updateDoc(doc(db, 'tenants', tenantId), { 'settings.autoCloseWhenAllOff': on });
    } catch (e) {
      setErr(e instanceof Error ? e.message : '設定の保存に失敗しました');
    }
  }

  function openTimeModal(date: string, staffId: string, staffName: string, entry: ShiftEntry | undefined) {
    const cur = entry && Array.isArray(entry.intervals) && entry.intervals.length > 0 ? entry.intervals[0] : null;
    setTimeModal({
      date,
      staffId,
      staffName,
      start: cur?.start ?? (businessHours[0]?.start ?? '09:00'),
      end: cur?.end ?? (businessHours[businessHours.length - 1]?.end ?? '19:00'),
    });
  }

  return (
    <section>
      {/* 説明・設定はモーダルに集約し、シフト表を上に出す（モバイルで表が下に行き過ぎない） */}
      <div className="cal-title-row">
        <h1>シフト管理</h1>
        <button type="button" className="cal-today-btn" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon size={15} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          設定
        </button>
      </div>
      <p className="muted" style={{ margin: '0 0 10px' }}>
        セルのボタンで出勤/休み/時間を設定。<strong>日付をタップすると休業日</strong>を設定できます（{horizonMonths}
        ヶ月先まで受付中）。
      </p>

      {err && <p className="error">{err}</p>}

      {/* シフト・予約受付の設定モーダル */}
      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>シフト・予約受付の設定</h2>
            </div>
            <label className="inline">
              シフト・予約受付の範囲
              <select value={horizonMonths} onChange={(e) => saveHorizon(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n}ヶ月先まで
                  </option>
                ))}
              </select>
            </label>
            <p className="muted" style={{ margin: '4px 0 12px' }}>
              シフト表がこの月数分表示され、お客様のWeb予約カレンダーも同じ範囲まで表示・受付されます
              （範囲外は「空きなし」に見えます）。未設定の日は営業時間（
              {businessHours.map((h) => `${h.start}〜${h.end}`).join(' / ')}）どおり出勤の扱いです。
            </p>
            <label className="inline" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={autoClose} onChange={(e) => saveAutoClose(e.target.checked)} />
              スタッフ全員が終日休みの日は、お客様に「休業日」として表示する
            </label>
            <p className="muted" style={{ margin: '2px 0 0' }}>
              OFFの場合は「予約がいっぱい」に見えます。手動の休業日（臨時休業・祝日）は常に最優先です。
            </p>
            <div className="modal-actions">
              <button type="button" className="primary" onClick={() => setSettingsOpen(false)}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {bookableStaff.length === 0 ? (
        <p className="muted">シフト対象のスタッフがいません（スタッフ管理でトリマーを追加してください）。</p>
      ) : (
        months.map(({ y, m }) => {
          const dayCount = new Date(y, m + 1, 0).getDate();
          const days = Array.from({ length: dayCount }, (_, i) => {
            const d = new Date(y, m, i + 1);
            return { ds: fmt(d), day: i + 1, dow: d.getDay() };
          });
          return (
            <div key={`${y}-${m}`} className="shift-month">
              <h2>
                {y}年{m + 1}月
              </h2>
              <div className="shift-table-wrap">
                <table className="shift-table">
                  <thead>
                    <tr>
                      <th className="shift-sticky">スタッフ</th>
                      {days.map((d) => (
                        <th key={d.ds} className={closedDates.has(d.ds) ? 'shift-closed-day' : ''}>
                          {/* 日付タップで休業日の設定/解除（過去日は表示のみ） */}
                          <button
                            type="button"
                            className="shift-day-head"
                            disabled={d.ds < today}
                            title="タップで休業日を設定/解除"
                            onClick={() =>
                              setClosureModal({
                                date: d.ds,
                                isClosed: closedDates.has(d.ds),
                                reason: closures.find((c) => c.id === d.ds)?.reason ?? '',
                              })
                            }
                          >
                            <span className={d.dow === 0 ? 'sun' : d.dow === 6 ? 'sat' : ''}>
                              {d.day}
                              <small>（{DOW[d.dow]}）</small>
                            </span>
                            {closedDates.has(d.ds) && <small className="shift-closed-mark">休業</small>}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {bookableStaff.map((s) => (
                      <tr key={s.id}>
                        <td className="shift-sticky">{s.name}</td>
                        {days.map((d) => {
                          const entry = shiftByDate.get(d.ds)?.staff?.[s.id];
                          const status = entryStatus(entry);
                          const isPast = d.ds < today;
                          const isClosed = closedDates.has(d.ds);
                          const isEditing = editing?.date === d.ds && editing?.staffId === s.id;
                          return (
                            <td key={d.ds} className={isClosed ? 'shift-closed-day' : ''}>
                              {isClosed ? (
                                <span className="muted" style={{ fontSize: '0.7rem' }}>
                                  休業
                                </span>
                              ) : status !== 'unset' && !isEditing ? (
                                // 設定済み: 色付きチップ。タップで選び直し（過去日は閲覧のみ）
                                <button
                                  type="button"
                                  className={`shift-chip ${status}`}
                                  disabled={isPast}
                                  onClick={() => setEditing({ date: d.ds, staffId: s.id })}
                                >
                                  {status === 'work' && '出勤'}
                                  {status === 'off' && '休み'}
                                  {status === 'custom' && (
                                    <>
                                      {entry!.intervals![0].start}
                                      <br />〜{entry!.intervals![0].end}
                                    </>
                                  )}
                                </button>
                              ) : (
                                // 未設定 or 選び直し中: 縦3ボタン。選択中は色で分かるように
                                <div className="shift-cell-stack">
                                  <button
                                    type="button"
                                    className={`shift-opt work${isEditing && status === 'work' ? ' current' : ''}`}
                                    disabled={isPast}
                                    onClick={() => writeEntry(d.ds, s.id, { work: true })}
                                  >
                                    出勤
                                  </button>
                                  <button
                                    type="button"
                                    className={`shift-opt off${isEditing && status === 'off' ? ' current' : ''}`}
                                    disabled={isPast}
                                    onClick={() => writeEntry(d.ds, s.id, { intervals: [] })}
                                  >
                                    休み
                                  </button>
                                  <button
                                    type="button"
                                    className={`shift-opt custom${isEditing && status === 'custom' ? ' current' : ''}`}
                                    disabled={isPast}
                                    onClick={() => openTimeModal(d.ds, s.id, s.name, entry)}
                                  >
                                    時間
                                  </button>
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })
      )}

      {/* 休業日モーダル（日付ヘッダーから。臨時休業・祝日） */}
      {closureModal && (
        <div className="modal-backdrop" onClick={() => setClosureModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>{closureModal.date} を{closureModal.isClosed ? '休業日から解除' : '休業日にする'}</h2>
            </div>
            {closureModal.isClosed ? (
              <p className="muted">
                この日は休業日です{closureModal.reason ? `（${closureModal.reason}）` : ''}。解除するとシフトどおりの受付に戻ります。
              </p>
            ) : (
              <>
                <p className="muted">お客様には「休業日」と表示され、予約を受け付けません（シフトより優先）。</p>
                <label>
                  理由（任意・例: 夏季休業）
                  <input
                    value={closureModal.reason}
                    onChange={(e) => setClosureModal((cm) => (cm ? { ...cm, reason: e.target.value } : cm))}
                  />
                </label>
              </>
            )}
            <div className="modal-actions">
              <button type="button" onClick={() => setClosureModal(null)}>
                キャンセル
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => saveClosure(closureModal.date, !closureModal.isClosed, closureModal.reason)}
              >
                {closureModal.isClosed ? '休業日を解除' : '休業日にする'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 時間指定モーダル（決定/キャンセル） */}
      {timeModal && (
        <div className="modal-backdrop" onClick={() => setTimeModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>
                {timeModal.staffName} ・ {timeModal.date.slice(5).replace('-', '/')} の勤務時間
              </h2>
            </div>
            <div className="row-form" style={{ alignItems: 'center' }}>
              <input
                type="time"
                value={timeModal.start}
                step={900}
                onChange={(e) => setTimeModal((tm) => (tm ? { ...tm, start: e.target.value } : tm))}
              />
              〜
              <input
                type="time"
                value={timeModal.end}
                step={900}
                onChange={(e) => setTimeModal((tm) => (tm ? { ...tm, end: e.target.value } : tm))}
              />
            </div>
            <p className="muted" style={{ marginTop: 6 }}>
              営業時間（{businessHours.map((h) => `${h.start}〜${h.end}`).join(' / ')}）の範囲内で有効です。
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setTimeModal(null)}>
                キャンセル
              </button>
              <button
                type="button"
                className="primary"
                disabled={!timeModal.start || !timeModal.end || timeModal.start >= timeModal.end}
                onClick={async () => {
                  await writeEntry(timeModal.date, timeModal.staffId, {
                    intervals: [{ start: timeModal.start, end: timeModal.end }],
                  });
                  setTimeModal(null);
                }}
              >
                決定
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
