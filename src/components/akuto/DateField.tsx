import { useEffect, useRef, useState } from 'react';
import { Calendar as CalendarIcon, ChevronDown, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import './akuto-date-field.css';

/*
 * 日付・時刻・月の選び方（AKUTO 全アプリ共通の形。BRANDBOOK「日付・時刻の選び方」）。
 * 原本は akuto-staff-app の src/components/DateField.tsx。各アプリへは見た目を変えずに写す。
 * 元は mobile_order 分析画面の CustomRangePicker（ポータルの DateRangePicker と同じ形）。
 * 色・角丸はトークンだけを使い、ブラウザ標準の日付欄（端末ごとに見た目が変わる）は使わない。
 *
 * - 欄：白地＋2px 枠・高さ44px・角丸12px。値は太字、未入力は補足色の文字。右に線アイコン。
 * - パネル：白・角丸24px・影1段。管理画面では欄の下に重ねる。スマホのフォーム（シートの中）は inline で欄の下に開く。
 * - 選択中＝文字色（黒）で塗った丸。今日＝黒い輪。日曜＝赤・土曜＝青（慣習の例外）。
 * 値の形は今までの input と同じ（日付 YYYY-MM-DD、時刻 HH:MM、月 YYYY-MM）。
 */

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const pad = (n: number) => String(n).padStart(2, '0');
const toYmd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const fmtDate = (s: string) => {
  const d = parseYmd(s);
  return d ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）` : '';
};
const fmtMonth = (s: string) => {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  return m ? `${m[1]}年${Number(m[2])}月` : '';
};

/** 欄の外を押したら閉じる */
function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

interface BaseProps {
  label?: string;
  placeholder?: string;
  /** スマホのフォーム（シートの中など）では欄の下に開く。管理画面では重ねて開く */
  inline?: boolean;
  /** 横に並べるときの幅（既定は 100%） */
  width?: number | string;
  disabled?: boolean;
}

function FieldButton({
  open,
  onClick,
  text,
  placeholder,
  icon: Icon,
  label,
  disabled,
}: {
  disabled?: boolean;
  open: boolean;
  onClick: () => void;
  text: string;
  placeholder: string;
  icon: typeof CalendarIcon;
  label?: string;
}) {
  return (
    <button
      type="button"
      className="ak-picker-field"
      data-open={open}
      aria-haspopup="dialog"
      aria-expanded={open}
      disabled={disabled}
      aria-label={label ? `${label}：${text || placeholder}` : undefined}
      onClick={onClick}
    >
      <span className={text ? 'ak-num' : 'ak-picker-placeholder'}>{text || placeholder}</span>
      <Icon size={18} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}

interface PanelProps {
  label?: string;
  inline?: boolean;
  /** 閉じる（選び終えた・外を押した・Esc） */
  onClose: () => void;
  /** 欄を使わず、自前のボタンから開くとき true（外を押したら閉じる） */
  closeOnOutside?: boolean;
}

function Panel({
  inline,
  children,
  label,
  onClose,
  closeOnOutside,
}: {
  inline?: boolean;
  children: React.ReactNode;
  label: string;
  onClose: () => void;
  closeOnOutside?: boolean;
}) {
  const ref = useOutside(!!closeOnOutside, onClose);
  return (
    <div ref={ref} className={`ak-picker${inline ? ' ak-picker-inline' : ''}`} role="dialog" aria-label={label}>
      {children}
    </div>
  );
}

/* ---------------- 日付 ---------------- */

/** 日付のパネルだけ。自前のボタン（「今日」の横の日付ボタンなど）から開くときに使う */
export function DatePanel({
  value,
  onPick,
  onClose,
  label,
  inline,
  closeOnOutside,
  min,
  max,
  startView = 'days',
}: PanelProps & {
  value: string;
  onPick: (v: string) => void;
  min?: string;
  max?: string;
  startView?: 'days' | 'years';
}) {
  const selected = parseYmd(value);
  const [view, setView] = useState<Date>(
    selected ?? (startView === 'years' ? new Date(new Date().getFullYear() - 20, 0, 1) : new Date()),
  );
  const [mode, setMode] = useState<'days' | 'months' | 'years'>(!selected && startView === 'years' ? 'years' : 'days');
  const yearsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode !== 'years') return;
    yearsRef.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'center' });
  }, [mode]);

  const y = view.getFullYear();
  const m = view.getMonth();
  const today = toYmd(new Date());
  const outOfRange = (d: Date) => {
    const k = toYmd(d);
    return (!!min && k < min) || (!!max && k > max);
  };

  const cells: { date: Date; other: boolean }[] = [];
  const first = new Date(y, m, 1).getDay();
  for (let i = first; i > 0; i -= 1) cells.push({ date: new Date(y, m, 1 - i), other: true });
  const days = new Date(y, m + 1, 0).getDate();
  for (let d = 1; d <= days; d += 1) cells.push({ date: new Date(y, m, d), other: false });
  while (cells.length % 7 !== 0) cells.push({ date: new Date(y, m + 1, cells.length - first - days + 1), other: true });

  const pick = (d: Date) => {
    onPick(toYmd(d));
    onClose();
  };

  const yearFrom = startView === 'years' ? new Date().getFullYear() - 80 : y - 10;
  const yearTo = startView === 'years' ? new Date().getFullYear() : y + 9;

  return (
    <Panel inline={inline} label={label ?? '日付を選ぶ'} onClose={onClose} closeOnOutside={closeOnOutside}>
      <div className="ak-picker-head">
        <button
          type="button"
          className="ak-picker-nav"
          aria-label={mode === 'months' ? '前の年' : '前の月'}
          style={{ visibility: mode === 'years' ? 'hidden' : undefined }}
          onClick={() => setView(mode === 'months' ? new Date(y - 1, m, 1) : new Date(y, m - 1, 1))}
        >
          <ChevronLeft size={18} strokeWidth={1.5} />
        </button>
        <div className="ak-picker-title">
          <button
            type="button"
            className="ak-picker-ym"
            aria-pressed={mode === 'years'}
            onClick={() => setMode(mode === 'years' ? 'days' : 'years')}
          >
            <span className="ak-num">{y}</span>年 <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ak-picker-ym"
            aria-pressed={mode === 'months'}
            onClick={() => setMode(mode === 'months' ? 'days' : 'months')}
          >
            <span className="ak-num">{m + 1}</span>月 <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          className="ak-picker-nav"
          aria-label={mode === 'months' ? '次の年' : '次の月'}
          style={{ visibility: mode === 'years' ? 'hidden' : undefined }}
          onClick={() => setView(mode === 'months' ? new Date(y + 1, m, 1) : new Date(y, m + 1, 1))}
        >
          <ChevronRight size={18} strokeWidth={1.5} />
        </button>
      </div>

      {mode === 'days' && (
        <>
          <div className="ak-picker-week">
            {WEEKDAYS.map((w, i) => (
              <span key={w} data-dow={i}>
                {w}
              </span>
            ))}
          </div>
          <div className="ak-picker-grid">
            {cells.map(({ date, other }) => {
              const ymd = toYmd(date);
              return (
                <button
                  key={ymd}
                  type="button"
                  className="ak-picker-day"
                  data-other={other}
                  data-dow={date.getDay()}
                  data-today={ymd === today}
                  aria-pressed={ymd === value}
                  aria-label={fmtDate(ymd)}
                  disabled={outOfRange(date)}
                  onClick={() => pick(date)}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
          <div className="ak-picker-foot">
            <button
              type="button"
              className="ak-picker-btn ak-picker-btn-quiet"
              disabled={outOfRange(new Date())}
              onClick={() => pick(new Date())}
            >
              今日
            </button>
          </div>
        </>
      )}

      {mode === 'months' && (
        <div className="ak-picker-cells3">
          {Array.from({ length: 12 }, (_, i) => (
            <button
              key={i}
              type="button"
              className="ak-picker-cell"
              aria-pressed={i === m}
              onClick={() => {
                setView(new Date(y, i, 1));
                setMode('days');
              }}
            >
              <span className="ak-num">{i + 1}</span>月
            </button>
          ))}
        </div>
      )}

      {mode === 'years' && (
        <div className="ak-picker-cells3 ak-picker-years" ref={yearsRef}>
          {Array.from({ length: yearTo - yearFrom + 1 }, (_, i) => yearFrom + i).map((yy) => (
            <button
              key={yy}
              type="button"
              className="ak-picker-cell"
              aria-pressed={yy === y}
              onClick={() => {
                setView(new Date(yy, m, 1));
                setMode(startView === 'years' && !selected ? 'months' : 'days');
              }}
            >
              {yy}
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function DateField({
  value,
  onChange,
  label,
  placeholder = '日付を選ぶ',
  inline,
  width,
  min,
  max,
  startView = 'days',
  disabled,
}: BaseProps & {
  value: string;
  onChange: (v: string) => void;
  min?: string;
  max?: string;
  /** 生年月日など、年から選ぶほうが早いときは 'years' */
  startView?: 'days' | 'years';
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  return (
    <div className="ak-picker-wrap" ref={ref} style={{ width }}>
      <FieldButton
        open={open}
        onClick={() => setOpen(!open)}
        text={fmtDate(value)}
        placeholder={placeholder}
        icon={CalendarIcon}
        label={label}
        disabled={disabled}
      />
      {open && (
        <DatePanel
          value={value}
          onPick={onChange}
          onClose={() => setOpen(false)}
          label={label}
          inline={inline}
          min={min}
          max={max}
          startView={startView}
        />
      )}
    </div>
  );
}

/* ---------------- 月 ---------------- */

export function MonthPanel({
  value,
  onPick,
  onClose,
  label,
  inline,
  closeOnOutside,
}: PanelProps & { value: string; onPick: (v: string) => void }) {
  const cur = /^(\d{4})-(\d{2})$/.exec(value);
  const [year, setYear] = useState(cur ? Number(cur[1]) : new Date().getFullYear());
  return (
    <Panel inline={inline} label={label ?? '月を選ぶ'} onClose={onClose} closeOnOutside={closeOnOutside}>
      <div className="ak-picker-head">
        <button type="button" className="ak-picker-nav" aria-label="前の年" onClick={() => setYear(year - 1)}>
          <ChevronLeft size={18} strokeWidth={1.5} />
        </button>
        <div className="ak-picker-title">
          <span className="ak-picker-ym" style={{ cursor: 'default' }}>
            <span className="ak-num">{year}</span>年
          </span>
        </div>
        <button type="button" className="ak-picker-nav" aria-label="次の年" onClick={() => setYear(year + 1)}>
          <ChevronRight size={18} strokeWidth={1.5} />
        </button>
      </div>
      <div className="ak-picker-cells3">
        {Array.from({ length: 12 }, (_, i) => {
          const v = `${year}-${pad(i + 1)}`;
          return (
            <button
              key={v}
              type="button"
              className="ak-picker-cell"
              aria-pressed={v === value}
              onClick={() => {
                onPick(v);
                onClose();
              }}
            >
              <span className="ak-num">{i + 1}</span>月
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

export function MonthField({
  value,
  onChange,
  label,
  placeholder = '月を選ぶ',
  inline,
  width,
  disabled,
}: BaseProps & { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  return (
    <div className="ak-picker-wrap" ref={ref} style={{ width }}>
      <FieldButton
        open={open}
        onClick={() => setOpen(!open)}
        text={fmtMonth(value)}
        placeholder={placeholder}
        icon={CalendarIcon}
        label={label}
        disabled={disabled}
      />
      {open && (
        <MonthPanel value={value} onPick={onChange} onClose={() => setOpen(false)} label={label} inline={inline} />
      )}
    </div>
  );
}

/* ---------------- 時刻 ---------------- */

type Step = 1 | 5 | 10 | 15 | 30;

export function TimePanel({
  value,
  onPick,
  onClose,
  label,
  inline,
  closeOnOutside,
  step = 5,
}: PanelProps & {
  value: string;
  onPick: (v: string) => void;
  /** 分の刻み。1 なら「10の位」「1の位」の2段で選ぶ */
  step?: Step;
}) {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  const h = m ? Number(m[1]) : null;
  const mi = m ? Number(m[2]) : null;

  const set = (hh: number | null, mm: number | null, close = false) => {
    onPick(`${pad(hh ?? 9)}:${pad(mm ?? 0)}`);
    if (close) onClose();
  };

  return (
    <Panel inline={inline} label={label ?? '時刻を選ぶ'} onClose={onClose} closeOnOutside={closeOnOutside}>
      <p className="ak-picker-sub">時</p>
      <div className="ak-picker-cells6">
        {Array.from({ length: 24 }, (_, i) => (
          <button
            key={i}
            type="button"
            className="ak-picker-cell"
            aria-pressed={i === h}
            onClick={() => set(i, mi)}
          >
            {i}
          </button>
        ))}
      </div>
      {step === 1 ? (
        <>
          <p className="ak-picker-sub">分（10の位）</p>
          <div className="ak-picker-cells6">
            {Array.from({ length: 6 }, (_, i) => (
              <button
                key={i}
                type="button"
                className="ak-picker-cell"
                aria-pressed={mi !== null && Math.floor(mi / 10) === i}
                onClick={() => set(h, i * 10 + ((mi ?? 0) % 10))}
              >
                {i}0
              </button>
            ))}
          </div>
          <p className="ak-picker-sub">分（1の位）</p>
          <div className="ak-picker-cells5">
            {Array.from({ length: 10 }, (_, i) => (
              <button
                key={i}
                type="button"
                className="ak-picker-cell"
                aria-pressed={mi !== null && mi % 10 === i}
                onClick={() => set(h, Math.floor((mi ?? 0) / 10) * 10 + i, h !== null)}
              >
                {i}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="ak-picker-sub">分</p>
          <div className="ak-picker-cells6">
            {Array.from({ length: 60 / step }, (_, i) => i * step).map((mm) => (
              <button
                key={mm}
                type="button"
                className="ak-picker-cell"
                aria-pressed={mm === mi}
                onClick={() => set(h, mm, h !== null)}
              >
                {pad(mm)}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="ak-picker-foot">
        <span className="ak-picker-now">{m ? `${h}:${pad(mi ?? 0)}` : '―'}</span>
        <button type="button" className="ak-picker-btn ak-picker-btn-sub" onClick={onClose}>
          決める
        </button>
      </div>
    </Panel>
  );
}

export function TimeField({
  value,
  onChange,
  label,
  placeholder = '時刻を選ぶ',
  inline,
  width,
  step = 5,
  disabled,
}: BaseProps & {
  value: string;
  onChange: (v: string) => void;
  step?: Step;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  return (
    <div className="ak-picker-wrap" ref={ref} style={{ width }}>
      <FieldButton
        open={open}
        onClick={() => setOpen(!open)}
        text={m ? `${Number(m[1])}:${m[2]}` : ''}
        placeholder={placeholder}
        icon={Clock}
        label={label}
        disabled={disabled}
      />
      {open && (
        <TimePanel
          value={value}
          onPick={onChange}
          onClose={() => setOpen(false)}
          label={label}
          inline={inline}
          step={step}
        />
      )}
    </div>
  );
}
