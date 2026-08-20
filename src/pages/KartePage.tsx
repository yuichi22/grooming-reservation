import { Fragment, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { addDoc } from 'firebase/firestore';
import { Archive, ChevronRight, Plus } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { breedsCol, customersCol, dogsCol } from '../lib/firestore';
import { useCollection } from '../lib/useCollection';
import type { Breed, Customer, Dog } from '../lib/types';

// 五十音インデックス（名前の先頭文字→行）。カタカナはひらがなに正規化して判定。
const KANA_ROWS: [string, string][] = [
  ['あ', 'あいうえおぁぃぅぇぉ'],
  ['か', 'かきくけこがぎぐげご'],
  ['さ', 'さしすせそざじずぜぞ'],
  ['た', 'たちつてとだぢづでどっ'],
  ['な', 'なにぬねの'],
  ['は', 'はひふへほばびぶべぼぱぴぷぺぽ'],
  ['ま', 'まみむめも'],
  ['や', 'やゆよゃゅょ'],
  ['ら', 'らりるれろ'],
  ['わ', 'わをんゎ'],
];
const ROW_ORDER = [...KANA_ROWS.map(([label]) => label), '他'];
function kanaRow(name: string): string {
  let c = (name ?? '').trim().charAt(0);
  if (!c) return '他';
  const code = c.codePointAt(0)!;
  if (code >= 0x30a1 && code <= 0x30f6) c = String.fromCodePoint(code - 0x60); // カタカナ→ひらがな
  for (const [label, set] of KANA_ROWS) if (set.includes(c)) return label;
  return '他'; // 漢字・英数字・記号など
}
/** 漢字（CJK統合漢字・拡張A・繰返し記号）を含むか。含む場合はふりがな必須にする。 */
export function hasKanji(s: string): boolean {
  return /[㐀-䶿一-鿿豈-﫿々〆]/.test(s ?? '');
}

export default function KartePage() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId;
  if (!tenantId) return <p className="error">テナントが割り当てられていません。</p>;
  return <KarteInner tenantId={tenantId} />;
}

function KarteInner({ tenantId }: { tenantId: string }) {
  const navigate = useNavigate();
  const { data: dogs, loading } = useCollection<Dog>(dogsCol(tenantId), [tenantId]);
  const { data: breeds } = useCollection<Breed>(breedsCol(tenantId), [tenantId]);
  const { data: customers } = useCollection<Customer>(customersCol(tenantId), [tenantId]);
  const breedName = useMemo(() => new Map(breeds.map((b) => [b.id, b.name])), [breeds]);
  const customerName = useMemo(() => new Map(customers.map((c) => [c.id, c.ownerName])), [customers]);

  // アーカイブは既定で隠す。件数が0なら切替ボタン自体を出さない（使わない店に余計な操作を見せない）
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = dogs.filter((d) => d.archivedAt).length;
  const visibleDogs = showArchived ? dogs : dogs.filter((d) => !d.archivedAt);

  // 五十音でグループ化（行内は名前の五十音順）。索引バー＋見出し区切りに使う。
  const groups = useMemo(() => {
    const byRow = new Map<string, Dog[]>();
    const key = (d: Dog) => (d.nameKana?.trim() || d.name); // 漢字名はふりがなで索引
    for (const d of visibleDogs) {
      const r = kanaRow(key(d));
      if (!byRow.has(r)) byRow.set(r, []);
      byRow.get(r)!.push(d);
    }
    for (const arr of byRow.values()) arr.sort((a, b) => key(a).localeCompare(key(b), 'ja'));
    return ROW_ORDER.filter((r) => byRow.has(r)).map((r) => ({ row: r, dogs: byRow.get(r)! }));
  }, [visibleDogs]);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [nameKana, setNameKana] = useState('');
  const [breedId, setBreedId] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  function closeModal() {
    if (busy) return;
    setOpen(false);
    setName('');
    setNameKana('');
    setBreedId('');
    setOwnerName('');
    setPhone('');
  }

  // §3 名寄せは電話番号で行うため、店頭でカルテを作るときに顧客（名前＋電話）も作成/再利用しておく。
  // 同じ電話で顧客が後から LINE 登録すると自動的にこの犬が紐づく。
  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    if (hasKanji(name) && !nameKana.trim()) return; // 漢字名はふりがな必須
    setBusy(true);
    try {
      const trimmedPhone = phone.trim();
      // ⚠電話番号は必須。中央CRMは電話/LINEを索引に person を名寄せするため、
      //   どちらも無い顧客は「二度と辿り着けない person」を来店のたびに増やしてしまう。
      const phoneDigits = trimmedPhone.replace(/\D/g, '');
      if (phoneDigits.length < 10) {
        setBusy(false);
        alert('電話番号を入力してください（お客様の名寄せに必要です）。');
        return;
      }
      let customerId = '';
      if (trimmedPhone) {
        const existing = customers.find((c) => !c.mergedInto && c.phone === trimmedPhone);
        if (existing) customerId = existing.id;
      }
      if (!customerId) {
        const cref = await addDoc(customersCol(tenantId), {
          memberId: null,
          ownerName: ownerName.trim(),
          phone: trimmedPhone,
          lineUserId: null,
          createdAt: new Date().toISOString(),
        } as Omit<Customer, 'id'> as Customer);
        customerId = cref.id;
      }
      const dref = await addDoc(dogsCol(tenantId), {
        customerId,
        name: name.trim(),
        nameKana: nameKana.trim() || null,
        breedId: breedId || null,
        confirmedDurationMin: null, // 初回は未確定 (§7)
      } as Omit<Dog, 'id'> as Dog);
      // 追加したら詳細（カルテ）を開く
      setOpen(false);
      navigate(`/karte/${dref.id}`);
    } finally {
      setBusy(false);
    }
  }

  // 索引タップでその行へ。固定ヘッダーの高さぶん差し引いて見出しが隠れないようにする。
  function jumpTo(row: string) {
    const el = document.getElementById(`karte-row-${row}`);
    if (!el) return;
    const container = el.closest('.content') as HTMLElement | null;
    const bar = document.querySelector('.karte-sticky') as HTMLElement | null;
    if (!container) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const offset = (bar?.getBoundingClientRect().height ?? 0) + 8;
    const top = Math.max(
      0,
      el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - offset,
    );
    const start = container.scrollTop;
    container.scrollTo({ top, behavior: 'smooth' });
    // スムーススクロール非対応(古いSafari)や無効の環境では上が無反応になるため、
    // 動いていなければ直接移動させる
    window.setTimeout(() => {
      if (container.scrollTop === start && Math.abs(top - start) > 2) container.scrollTop = top;
    }, 120);
  }

  return (
    <section>
      {/* ヘッダー＋五十音インデックスをまとめてスクロール追従 */}
      <div className="karte-sticky">
        <div className="page-head">
          <h1>カルテ（犬）</h1>
          {archivedCount > 0 && (
            <button
              type="button"
              className={showArchived ? 'btn-primary' : ''}
              onClick={() => setShowArchived((v) => !v)}
            >
              <Archive size={15} style={{ marginRight: 6, verticalAlign: '-2px' }} />
              {showArchived ? `アーカイブを隠す` : `アーカイブも表示（${archivedCount}）`}
            </button>
          )}
          <button type="button" onClick={() => setOpen(true)}>
            <Plus size={16} style={{ marginRight: 6, verticalAlign: '-2px' }} />
            カルテを追加
          </button>
        </div>
        {!loading && groups.length > 1 && (
          <div className="kana-index">
            {groups.map((g) => (
              <button key={g.row} type="button" onClick={() => jumpTo(g.row)}>
                {g.row === '他' ? '他' : g.row}
              </button>
            ))}
          </div>
        )}
      </div>

      {open && (
        <div className="modal-backdrop" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>カルテを追加</h2>
            <form onSubmit={onAdd}>
              <label>
                犬の名前
                <input placeholder="犬の名前" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              {hasKanji(name) && (
                <label>
                  ふりがな（漢字名は必須）
                  <input
                    placeholder="例: そら"
                    value={nameKana}
                    onChange={(e) => setNameKana(e.target.value)}
                  />
                </label>
              )}
              <label>
                犬種
                <select value={breedId} onChange={(e) => setBreedId(e.target.value)}>
                  <option value="">犬種を選択</option>
                  {breeds.filter((b) => b.active).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                飼い主名（任意）
                <input placeholder="飼い主名（任意）" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
              </label>
              <label>
                電話番号（任意）
                <input placeholder="電話番号（必須）" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </label>
              <p className="muted">
                電話番号を入れておくと、その方が同じ番号で LINE 登録したときに自動でこの犬が紐づきます。
              </p>
              <div className="modal-actions">
                <button type="button" onClick={closeModal} disabled={busy}>
                  キャンセル
                </button>
                <button type="submit" disabled={busy || !name.trim() || (hasKanji(name) && !nameKana.trim())}>
                  {busy ? '作成中…' : 'カルテを追加'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loading ? (
        <p>読み込み中…</p>
      ) : (
        <div className="table-wrap"><table>
          <thead>
            <tr>
              <th>名前</th>
              <th>犬種</th>
              <th>飼い主</th>
              <th>確定作業時間</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.row}>
                <tr className="kana-group" id={`karte-row-${g.row}`}>
                  <td colSpan={5}>{g.row === '他' ? 'その他' : `${g.row}行`}</td>
                </tr>
                {g.dogs.map((d) => (
                  <tr key={d.id} className="row-link" onClick={() => navigate(`/karte/${d.id}`)}>
                    <td>
                      {d.name}
                      {d.archivedAt && (
                        <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>
                          （アーカイブ）
                        </span>
                      )}
                    </td>
                    <td>{(d.breedId && breedName.get(d.breedId)) || d.breed || '—'}</td>
                    <td>{customerName.get(d.customerId) || '—'}</td>
                    <td>{d.confirmedDurationMin != null ? `${d.confirmedDurationMin}分` : '未確定'}</td>
                    <td className="chevron-cell">
                      <ChevronRight size={18} />
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
            {groups.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  {dogs.length === 0 ? 'カルテ未登録' : 'アーカイブ以外のカルテはありません'}
                </td>
              </tr>
            )}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
