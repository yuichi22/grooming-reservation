import { useState, type FormEvent } from 'react';
import { addDoc, deleteDoc, doc, updateDoc } from 'firebase/firestore';
import { useAuth } from '../auth/AuthContext';
import { menusCol } from '../lib/firestore';
import { useCollection } from '../lib/useCollection';
import type { Menu } from '../lib/types';

export default function MenusPage() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId;

  if (!tenantId) return <NoTenant />;
  return <MenusInner tenantId={tenantId} />;
}

function NoTenant() {
  return <p className="error">テナントが割り当てられていません。</p>;
}

function MenusInner({ tenantId }: { tenantId: string }) {
  const { data: menus, loading } = useCollection<Menu>(menusCol(tenantId), [tenantId]);

  const [name, setName] = useState('');
  const [defaultDurationMin, setDuration] = useState(80);
  const [fixedDuration, setFixed] = useState(false);
  const [price, setPrice] = useState(5500);

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await addDoc(menusCol(tenantId), {
      name: name.trim(),
      defaultDurationMin,
      fixedDuration,
      price,
      active: true,
    } as Omit<Menu, 'id'> as Menu);
    setName('');
  }

  async function toggleActive(m: Menu) {
    await updateDoc(doc(menusCol(tenantId), m.id), { active: !m.active });
  }

  async function remove(m: Menu) {
    if (confirm(`「${m.name}」を削除しますか？`)) {
      await deleteDoc(doc(menusCol(tenantId), m.id));
    }
  }

  return (
    <section>
      <h1>メニュー</h1>
      <form className="row-form" onSubmit={onAdd}>
        <input placeholder="メニュー名" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="inline">
          標準時間(分)
          <input
            type="number"
            min={10}
            step={5}
            value={defaultDurationMin}
            onChange={(e) => setDuration(Number(e.target.value))}
          />
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={fixedDuration}
            onChange={(e) => setFixed(e.target.checked)}
          />
          固定時間（例: シャンプー）
        </label>
        <label className="inline">
          料金
          <input type="number" min={0} step={100} value={price} onChange={(e) => setPrice(Number(e.target.value))} />
        </label>
        <button type="submit">追加</button>
      </form>

      {loading ? (
        <p>読み込み中…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>名前</th>
              <th>標準時間</th>
              <th>固定</th>
              <th>料金</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {menus.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td>{m.defaultDurationMin}分</td>
                <td>{m.fixedDuration ? '固定' : '—'}</td>
                <td>¥{m.price.toLocaleString()}</td>
                <td>{m.active ? '有効' : '無効'}</td>
                <td>
                  <button onClick={() => toggleActive(m)}>{m.active ? '無効化' : '有効化'}</button>
                  <button onClick={() => remove(m)}>削除</button>
                </td>
              </tr>
            ))}
            {menus.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  メニュー未登録
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}
