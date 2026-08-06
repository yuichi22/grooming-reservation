import { useEffect, useState, type FormEvent } from 'react';
import { updateDoc } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { tenantDoc } from '../lib/firestore';
import { useDocument } from '../lib/useDocument';
import type { BusinessHours, Tenant, TenantSettings } from '../lib/types';

export default function SettingsPage() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId;
  if (!tenantId) return <p className="error">テナントが割り当てられていません。</p>;
  return <SettingsInner tenantId={tenantId} />;
}

function SettingsInner({ tenantId }: { tenantId: string }) {
  const { data: tenant, loading } = useDocument<Tenant>(tenantDoc(tenantId), [tenantId]);

  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (tenant) {
      setSettings(tenant.settings);
      setName(tenant.name);
    }
  }, [tenant]);

  if (loading || !settings) return <p>読み込み中…</p>;

  function setHours(i: number, key: keyof BusinessHours, value: string) {
    setSettings((s) =>
      s
        ? { ...s, businessHours: s.businessHours.map((h, idx) => (idx === i ? { ...h, [key]: value } : h)) }
        : s,
    );
  }
  function addHours() {
    setSettings((s) => (s ? { ...s, businessHours: [...s.businessHours, { start: '09:00', end: '19:00' }] } : s));
  }
  function removeHours(i: number) {
    setSettings((s) => (s ? { ...s, businessHours: s.businessHours.filter((_, idx) => idx !== i) } : s));
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setMsg(null);
    await updateDoc(tenantDoc(tenantId), { name, settings });
    setMsg('保存しました');
  }

  return (
    <section>
      <h1>設定</h1>
      <form onSubmit={onSave}>
        <fieldset>
          <legend>営業時間（空き計算の基準）</legend>
          {settings.businessHours.map((h, i) => (
            <div className="row-form" key={i}>
              <input type="time" value={h.start} onChange={(e) => setHours(i, 'start', e.target.value)} />
              〜
              <input type="time" value={h.end} onChange={(e) => setHours(i, 'end', e.target.value)} />
              <button type="button" onClick={() => removeHours(i)}>
                削除
              </button>
            </div>
          ))}
          <button type="button" onClick={addHours}>
            + 区間を追加
          </button>
        </fieldset>

        <label className="inline">
          バッファ(分)
          <input
            type="number"
            min={0}
            step={5}
            value={settings.bufferMin}
            onChange={(e) => setSettings((s) => (s ? { ...s, bufferMin: Number(e.target.value) } : s))}
          />
        </label>

        <label className="inline">
          作業時間の選択肢（カンマ区切り・フリー入力不可）
          <input
            value={settings.workTimeOptions.join(', ')}
            onChange={(e) =>
              setSettings((s) =>
                s
                  ? {
                      ...s,
                      workTimeOptions: e.target.value
                        .split(',')
                        .map((v) => Number(v.trim()))
                        .filter((v) => Number.isFinite(v) && v > 0),
                    }
                  : s,
              )
            }
          />
        </label>

        <label className="inline">
          タイムゾーン
          <input
            value={settings.timezone}
            onChange={(e) => setSettings((s) => (s ? { ...s, timezone: e.target.value } : s))}
          />
        </label>

        <label className="inline">
          キャンセル締切（開始の何時間前まで可）
          <input
            type="number"
            min={0}
            step={1}
            value={settings.cancelDeadlineHours ?? 24}
            onChange={(e) => setSettings((s) => (s ? { ...s, cancelDeadlineHours: Number(e.target.value) } : s))}
          />
        </label>

        <label className="inline">
          予約受付の締切（予約開始の何時間前まで受付可・0=直前まで）
          <input
            type="number"
            min={0}
            step={1}
            value={settings.bookingCutoffHours ?? 0}
            onChange={(e) => setSettings((s) => (s ? { ...s, bookingCutoffHours: Number(e.target.value) } : s))}
          />
        </label>

        <fieldset>
          <legend>消費税</legend>
          <label className="inline">
            税率(%)
            <input
              type="number"
              min={0}
              step={1}
              value={settings.taxRate ?? 10}
              onChange={(e) => setSettings((s) => (s ? { ...s, taxRate: Number(e.target.value) } : s))}
            />
          </label>
          <label className="inline">
            表示
            <select
              value={settings.taxMode ?? 'exclusive'}
              onChange={(e) =>
                setSettings((s) => (s ? { ...s, taxMode: e.target.value as 'inclusive' | 'exclusive' } : s))
              }
            >
              <option value="exclusive">税抜（税込を併記）</option>
              <option value="inclusive">税込</option>
            </select>
          </label>
        </fieldset>

        <fieldset>
          <legend>店舗情報（ヘッダー表示・LINE 文面に使用）</legend>
          <label>
            店舗名
            <input value={name} placeholder="例: GROOM HAUS" onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            ロゴ画像URL（ヘッダー中央に表示）
            <input
              value={settings.logoUrl ?? ''}
              placeholder="例: https://.../logo.png"
              onChange={(e) => setSettings((s) => (s ? { ...s, logoUrl: e.target.value } : s))}
            />
          </label>
          <label>
            住所
            <input
              value={settings.address ?? ''}
              placeholder="例: 島根県松江市〇〇1-2-3"
              onChange={(e) => setSettings((s) => (s ? { ...s, address: e.target.value } : s))}
            />
          </label>
          <label>
            地図URL（Google マップ等）
            <input
              value={settings.mapUrl ?? ''}
              placeholder="例: https://maps.google.com/?q=..."
              onChange={(e) => setSettings((s) => (s ? { ...s, mapUrl: e.target.value } : s))}
            />
          </label>
          <label>
            電話番号
            <input
              value={settings.phone ?? ''}
              placeholder="例: 0852-00-0000"
              onChange={(e) => setSettings((s) => (s ? { ...s, phone: e.target.value } : s))}
            />
          </label>
        </fieldset>

        <div>
          <button type="submit">保存</button>
          {msg && <span className="muted" style={{ marginLeft: 12 }}>{msg}</span>}
        </div>
      </form>

      {/* 休業日の管理は営業カレンダーの一部としてシフトへ集約（二重管理の入口を作らない） */}
      <section style={{ marginTop: 32 }}>
        <h2>休業日（臨時休業・祝日）</h2>
        <p className="muted">
          休業日の設定は「シフト」ページへ移動しました。月表の日付をタップして設定・解除できます
          （予約カレンダーの月表示からも設定できます）。
        </p>
      </section>
    </section>
  );
}
