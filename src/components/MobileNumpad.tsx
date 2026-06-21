import { useEffect, useRef, useState } from 'react';

// モバイル幅のしきい値（CSS のサイドバー切替と同じ）
const MOBILE_MAX = 820;
const isMobile = () => window.innerWidth < MOBILE_MAX;

/**
 * モバイル時、すべての <input type="number"> をタップしたら電卓風のキーパッドを開き、
 * 入力した数字を「決定」でフォームに反映する共通コンポーネント（一度だけマウントする）。
 *
 * - ネイティブのキーボードを出さないため、モバイルでは number 入力を readOnly にする
 *   （プログラムからの値書き込み＋input イベント発火で React の onChange は従来どおり動く）。
 * - 数字のスピンボタン（上下矢印）は CSS 側で全廃。
 */
export default function MobileNumpad() {
  const [target, setTarget] = useState<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState('');
  const targetRef = useRef<HTMLInputElement | null>(null);

  // モバイルでは number 入力を readOnly にしてOSキーボードを抑止（動的に増える入力にも対応）
  useEffect(() => {
    const markAll = () => {
      if (!isMobile()) return;
      document.querySelectorAll<HTMLInputElement>('input[type="number"]').forEach((i) => (i.readOnly = true));
    };
    const clearAll = () => {
      document.querySelectorAll<HTMLInputElement>('input[type="number"]').forEach((i) => (i.readOnly = false));
    };
    markAll();
    const obs = new MutationObserver((muts) => {
      if (!isMobile()) return;
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement)) return;
          if (n.matches('input[type="number"]')) (n as HTMLInputElement).readOnly = true;
          n.querySelectorAll<HTMLInputElement>('input[type="number"]').forEach((i) => (i.readOnly = true));
        });
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    const onResize = () => (isMobile() ? markAll() : clearAll());
    window.addEventListener('resize', onResize);
    return () => {
      obs.disconnect();
      window.removeEventListener('resize', onResize);
      clearAll();
    };
  }, []);

  // number 入力のタップでキーパッドを開く
  useEffect(() => {
    const open = (el: HTMLInputElement) => {
      if (targetRef.current === el) return; // 同じタップの別イベントを無視
      targetRef.current = el;
      setTarget(el);
      setDraft(el.value === '0' ? '' : el.value); // 既定の 0 は空から入力できるように
    };
    // pointerdown で preventDefault → フォーカスを与えない＝OSキーボードも自動スクロールも起きない
    const onDown = (e: Event) => {
      if (!isMobile()) return;
      const el = e.target;
      if (el instanceof HTMLInputElement && el.type === 'number') {
        e.preventDefault();
        open(el);
      }
    };
    // pointer 非対応環境のフォールバック
    const onClick = (e: Event) => {
      if (!isMobile()) return;
      const el = e.target;
      if (el instanceof HTMLInputElement && el.type === 'number') open(el);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('click', onClick, true);
    };
  }, []);

  if (!target) return null;

  const close = () => {
    targetRef.current = null;
    setTarget(null);
  };
  const press = (k: string) => setDraft((d) => (d === '0' ? k : d + k));
  const back = () => setDraft((d) => d.slice(0, -1));
  const clear = () => setDraft('');
  const commit = () => {
    const value = draft === '' ? '0' : draft;
    const t = targetRef.current;
    if (t) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(t, value);
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new Event('change', { bubbles: true }));
    }
    close();
  };

  return (
    <div className="numpad-backdrop" onClick={close}>
      <div className="numpad" onClick={(e) => e.stopPropagation()}>
        <div className="numpad-display">{draft || '0'}</div>
        <div className="numpad-grid">
          {['7', '8', '9', '4', '5', '6', '1', '2', '3'].map((k) => (
            <button type="button" key={k} onClick={() => press(k)}>
              {k}
            </button>
          ))}
          <button type="button" className="numpad-fn" onClick={clear}>
            C
          </button>
          <button type="button" onClick={() => press('0')}>
            0
          </button>
          <button type="button" className="numpad-fn" onClick={back} aria-label="一文字削除">
            ⌫
          </button>
        </div>
        <div className="numpad-actions">
          <button type="button" className="numpad-cancel" onClick={close}>
            キャンセル
          </button>
          <button type="button" className="numpad-ok" onClick={commit}>
            決定
          </button>
        </div>
      </div>
    </div>
  );
}
