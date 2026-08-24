import { useEffect, useState, type FormEvent } from 'react';
import { updateDoc } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { doc } from 'firebase/firestore';
import { db } from '../firebaseStaff';
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

      <LineUsage tenantId={tenantId} hasOwnOa={!!tenant?.lineConfig?.messagingChannelAccessToken} />

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

/**
 * 今月の LINE 送信通数。
 * ⚠LINE の請求は公式アカウント単位でしか出ないため、共有アカウントを複数店で使うと
 *   「どの店が何通使ったか」が分からなくなる。ここで内訳を見せる。
 */
function LineUsage({ tenantId, hasOwnOa }: { tenantId: string; hasOwnOa: boolean }) {
  const month = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .slice(0, 7);

  const { data: usage } = useDocument<Record<string, number>>(
    doc(db, 'tenants', tenantId, 'lineUsage', month) as never,
    [tenantId, month],
  );

  const n = (k: string) => Number(usage?.[k] ?? 0);
  const total = n('total');
  const rows: [string, number][] = [
    ['予約確定', n('kind_confirmation')],
    ['前日リマインド', n('kind_reminder')],
    ['キャンセル', n('kind_cancel')],
    ['日時変更', n('kind_reschedule')],
    ['個別メッセージ', n('kind_manual')],
  ];

  return (
    <section style={{ marginTop: 32 }}>
      <h2>LINE送信（{month}）</h2>
      {total === 0 ? (
        <p className="muted">今月の送信はまだありません。</p>
      ) : (
        <>
          <p style={{ fontWeight: 800, fontSize: 20, margin: '4px 0' }}>{total.toLocaleString()} 通</p>
          <ul className="muted" style={{ margin: '4px 0 10px', paddingLeft: 18 }}>
            {rows.filter(([, v]) => v > 0).map(([label, v]) => (
              <li key={label}>
                {label}: {v.toLocaleString()} 通
              </li>
            ))}
          </ul>
        </>
      )}
      {hasOwnOa ? (
        <p className="muted">
          店舗専用の LINE 公式アカウントから送信しています。料金はそのアカウントのプランに従います。
        </p>
      ) : (
        /* ⚠共有OAは通数枠(スタンダードプラン=月30,000通)を全店で食い合う。
           ただし枠内なら1通あたりの追加費用は0円なので、費用を理由に急かさず
           「できることが増える」案内にとどめる。枠の残りは npm run line-usage:prod で見る。 */
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--surface)',
            padding: '12px 14px',
            marginTop: 4,
          }}
        >
          <p style={{ margin: '0 0 8px' }}>共有の LINE 公式アカウントから送信しています。</p>
          <p className="muted" style={{ margin: '0 0 6px' }}>
            店舗専用のアカウントを登録すると、次のことができるようになります。
          </p>
          <ul className="muted" style={{ margin: '0 0 10px', paddingLeft: 18, lineHeight: 1.7 }}>
            <li>お客様に<strong>店舗名で届く</strong>（現在は共有アカウント名で届いています）</li>
            <li>予約画面から<strong>個別メッセージ・お迎え依頼</strong>を送れる</li>
            <li>お客様が<strong>そのまま返信できる</strong></li>
            <li>友だちへの<strong>一斉配信</strong>ができる</li>
          </ul>
          <p className="muted" style={{ margin: 0 }}>
            ご希望の場合はお問い合わせください。アカウントの接続はこちらで行います。
          </p>
        </div>
      )}
    </section>
  );
}
