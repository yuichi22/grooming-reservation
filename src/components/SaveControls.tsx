// 保存バー・確認ダイアログ・保存していない変更の見張り【AKUTOブランド基準 10-10】
// mobile_order / 空間OS の SaveControls と同じ決まり:
// - 保存は1ページに1か所。変更があるときだけ画面下に出るバー(ChangesBar)の右端に［元に戻す］［保存］
// - 保存バーが出ている間に別画面へ移る操作は confirmLeaveIfUnsaved() を通す(確認し、移るなら変更を捨てる)
// - 確認は confirm() ではなく appConfirm()(縦に［実行］［キャンセル］・取り消せない操作だけ赤)
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Save } from 'lucide-react';

// ── 確認ダイアログ ──
type ConfirmOptions = { title?: string; okLabel?: string; cancelLabel?: string; tone?: 'default' | 'danger' };
type ConfirmRequest = { message: string; options: ConfirmOptions; resolve: (ok: boolean) => void };

let confirmListener: ((req: ConfirmRequest) => void) | null = null;

export function appConfirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  if (!confirmListener) return Promise.resolve(window.confirm(message));
  return new Promise((resolve) => confirmListener?.({ message, options, resolve }));
}

// アプリのいちばん外側に1つだけ置く
export function AppConfirmHost() {
  const [queue, setQueue] = useState<ConfirmRequest[]>([]);
  const current = queue[0] ?? null;

  useEffect(() => {
    confirmListener = (req) => setQueue((prev) => [...prev, req]);
    return () => {
      confirmListener = null;
    };
  }, []);

  const settle = (ok: boolean) => {
    setQueue((prev) => {
      const [head, ...rest] = prev;
      head?.resolve(ok);
      return rest;
    });
  };

  useEffect(() => {
    if (!current) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        settle(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [current]);

  if (!current) return null;
  const { title = '確認', okLabel = 'OK', cancelLabel = 'キャンセル', tone = 'default' } = current.options;

  return createPortal(
    <div className="confirm-backdrop">
      <div className="confirm-dialog" role="alertdialog" aria-label={title}>
        <div className="confirm-title">{title}</div>
        <div className="confirm-message">{current.message}</div>
        <div className="confirm-actions">
          <button type="button" autoFocus className={tone === 'danger' ? 'confirm-ok danger' : 'confirm-ok'} onClick={() => settle(true)}>
            {okLabel}
          </button>
          <button type="button" className="confirm-cancel" onClick={() => settle(false)}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── 保存していない変更の見張り ──
const unsavedSources = new Map<number, { discard: () => void }>();
let unsavedSeq = 0;

export const hasUnsavedChanges = () => unsavedSources.size > 0;

export function useUnsavedRegistration(dirty: boolean, discard?: () => void) {
  const discardRef = useRef(discard);
  useEffect(() => {
    discardRef.current = discard;
  }, [discard]);
  useEffect(() => {
    if (!dirty) return undefined;
    unsavedSeq += 1;
    const id = unsavedSeq;
    unsavedSources.set(id, { discard: () => discardRef.current?.() });
    return () => {
      unsavedSources.delete(id);
    };
  }, [dirty]);
}

declare global {
  interface Window {
    __akutoUnsavedGuard?: boolean;
  }
}
if (typeof window !== 'undefined' && !window.__akutoUnsavedGuard) {
  window.__akutoUnsavedGuard = true;
  window.addEventListener('beforeunload', (event) => {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

// 移ってよければ true。未保存があるときは確認し、移るなら変更を捨てる(元に戻す)
export async function confirmLeaveIfUnsaved(): Promise<boolean> {
  if (!hasUnsavedChanges()) return true;
  const ok = await appConfirm('保存していない変更があります。このまま移動すると、変更は保存されません。', {
    title: '保存していない変更',
    okLabel: '移動する',
    cancelLabel: 'このページに残る',
    tone: 'danger',
  });
  if (!ok) return false;
  [...unsavedSources.values()].forEach((s) => {
    try {
      s.discard();
    } catch {
      /* 無視 */
    }
  });
  unsavedSources.clear();
  return true;
}

// ── 変更があるときだけ画面下に出るバー ──
// どこに置いてもよい。Layout の置き場に出て、本文の列の幅のまま画面の下端に貼り付く(position: sticky)
export function ChangesBar({
  dirty,
  onSave,
  onDiscard,
  saving = false,
  disabled = false,
  message = '保存していない変更があります',
  saveLabel = '保存',
}: {
  dirty: boolean;
  onSave: () => void;
  onDiscard?: () => void;
  saving?: boolean;
  disabled?: boolean;
  message?: string;
  saveLabel?: string;
}) {
  useUnsavedRegistration(dirty, onDiscard);
  if (!dirty && !saving) return null;
  const bar = (
    <div className="changes-bar" role="region" aria-label="保存">
      <div className="changes-bar-message">{message}</div>
      {onDiscard && (
        <button type="button" className="changes-bar-discard" onClick={onDiscard} disabled={saving}>
          元に戻す
        </button>
      )}
      <button type="button" className="btn-primary changes-bar-save" onClick={onSave} disabled={saving || disabled}>
        <Save size={16} strokeWidth={2.5} aria-hidden="true" />
        {saving ? '保存中…' : saveLabel}
      </button>
    </div>
  );
  // Layout の #akuto-savebar-slot(本文の列の下端に貼り付く)に出す
  const slot = typeof document !== 'undefined' ? document.getElementById('akuto-savebar-slot') : null;
  return slot ? createPortal(bar, slot) : bar;
}
