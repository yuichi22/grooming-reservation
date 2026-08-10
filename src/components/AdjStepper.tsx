import { minAdj } from '../lib/adjust';

/**
 * 個別加算（分）の入力。−/＋ ボタンと直接入力を1つにまとめたステッパー。
 *
 * 施術中の濡れた手・タブレットでの操作を前提にしているので、
 * キーボードを出さずに 5分刻みで動かせることを優先する（直接入力も残す）。
 * ⚠ 符号は数値そのものに出す（-15）。「短縮」「加算」のようなラベルで表すと、
 *   ラベルを見落としたときに符号が逆に読めてしまうため。
 */
export default function AdjStepper({
  value,
  stdMin,
  onChange,
  step = 5,
}: {
  value: number;
  /** 標準時間。これを食い切らないよう下限に使う */
  stdMin: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  const lo = minAdj(stdMin);
  const clamp = (v: number) => Math.max(lo, Math.min(600, Math.round(v)));
  const tone = value > 0 ? 'plus' : value < 0 ? 'minus' : 'zero';

  return (
    <span className={`adj-stepper ${tone}`}>
      <button
        type="button"
        className="adj-btn"
        aria-label={`${step}分 減らす`}
        disabled={value <= lo}
        onClick={() => onChange(clamp(value - step))}
      >
        −
      </button>
      <input
        type="number"
        step={step}
        min={lo}
        value={value}
        aria-label="個別加算（分）"
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
      />
      <span className="adj-unit">分</span>
      <button
        type="button"
        className="adj-btn"
        aria-label={`${step}分 増やす`}
        onClick={() => onChange(clamp(value + step))}
      >
        ＋
      </button>
    </span>
  );
}
