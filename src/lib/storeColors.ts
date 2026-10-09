// 店の色(お客様の予約画面のボタン・空き枠)の候補。AKUTO 共通の7色(mobile_order と同じ)。
// 既定はスチールブルー(AKUTO の色)。白文字 4.5:1 以上・黒との差 3 以上を満たす色だけ。
export const DEFAULT_STORE_ACCENT = '#3B6E8F';

export const STORE_ACCENT_COLORS: { value: string; label: string }[] = [
  { value: '#3B6E8F', label: 'スチールブルー' },
  { value: '#15803D', label: 'グリーン' },
  { value: '#0F766E', label: 'ティール' },
  { value: '#2563EB', label: 'ブルー' },
  { value: '#9333EA', label: 'パープル' },
  { value: '#9A5B2E', label: 'ブロンズ' },
  { value: '#C2410C', label: 'テラコッタ' },
];

/** 予約画面に店の色を差し込む(--accent。濃淡は CSS の color-mix で作る) */
export function applyStoreAccent(color: string | null | undefined) {
  const v = /^#[0-9a-f]{6}$/i.test(String(color ?? '')) ? String(color) : DEFAULT_STORE_ACCENT;
  document.documentElement.style.setProperty('--accent', v);
}
