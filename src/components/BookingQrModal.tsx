import { useRef, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { X } from 'lucide-react';

/**
 * 店舗の予約QR（顧客が読むと ?tenant= 付きで予約画面が開く）を表示するモーダル。
 * 内容: https://liff.line.me/<LIFF_ID>?tenant=<tenantId>
 */
export default function BookingQrModal({
  tenantId,
  storeName,
  onClose,
}: {
  tenantId: string;
  storeName: string;
  onClose: () => void;
}) {
  const liffId = (import.meta.env.VITE_LIFF_ID as string | undefined) ?? '';
  const url = `https://liff.line.me/${liffId}?tenant=${tenantId}`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* クリップボード不可の環境では無視（URLは表示済み） */
    }
  }

  function download() {
    const canvas = wrapRef.current?.querySelector('canvas');
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `予約QR-${storeName || tenantId}.png`;
    a.click();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal qr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>予約QR</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="閉じる">
            <X size={20} />
          </button>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          お客様がこのQRを読み取ると、{storeName || 'この店舗'}の予約画面が開きます。
        </p>
        <div className="qr-canvas" ref={wrapRef}>
          {liffId ? (
            <QRCodeCanvas value={url} size={232} marginSize={2} />
          ) : (
            <p className="error">LIFF ID が未設定です（開発モード）。本番ビルドで表示されます。</p>
          )}
        </div>
        <div className="qr-url">{url}</div>
        <div className="modal-actions">
          <button type="button" onClick={copy}>
            {copied ? 'コピーしました' : 'リンクをコピー'}
          </button>
          <button type="button" className="primary" onClick={download} disabled={!liffId}>
            画像を保存
          </button>
        </div>
      </div>
    </div>
  );
}
