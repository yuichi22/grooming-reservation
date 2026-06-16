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
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (tenant) setSettings(tenant.settings);
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
    await updateDoc(tenantDoc(tenantId), { settings });
    setMsg('保存しました');
  }

  return (
    <section>
      <h1>設定</h1>
      <form onSubmit={onSave}>
        <fieldset>
          <legend>営業時間 (§6 空き計算の基準)</legend>
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
          作業時間の選択肢（カンマ区切り・フリー入力不可 §6）
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

        <div>
          <button type="submit">保存</button>
          {msg && <span className="muted" style={{ marginLeft: 12 }}>{msg}</span>}
        </div>
      </form>
    </section>
  );
}
