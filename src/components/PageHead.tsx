// 管理画面のカードの「見出しの帯」と、画面の中の切り替え(丸ボタン)【AKUTOブランド基準 10-10: 設定画面の見出し】
// mobile_order / 空間OS の SettingsCardHeader・SubTabs と同じ形。画面ごとに作り直さない。
// - 帯: 高さ96px・薄い青みの地・下に細い線。左=黒い角丸アイコン＋タイトル(20px)＋小さな補足、右=操作
// - カード(section)の一番上に置く。ページ最初のカードのタイトル=左メニューの名前
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function PageHead({
  icon: Icon,
  title,
  meta,
  actions,
  level = 1,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  level?: 1 | 2;
}) {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <div className="card-head">
      <div className="card-head-main">
        {Icon && (
          <span className="card-head-icon" aria-hidden="true">
            <Icon size={24} strokeWidth={2.25} />
          </span>
        )}
        <div className="card-head-text">
          <Heading className="card-head-title">{title}</Heading>
          {meta && <div className="card-head-meta">{meta}</div>}
        </div>
      </div>
      {actions && <div className="card-head-actions">{actions}</div>}
    </div>
  );
}

export function SubTabs<T extends string>({
  items,
  value,
  onChange,
}: {
  items: [T, string][];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="subtabs" role="tablist">
      {items.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={value === key}
          className={`subtab${value === key ? ' active' : ''}`}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
