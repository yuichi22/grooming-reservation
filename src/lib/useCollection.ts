// Firestore コレクションを購読する軽量フック。
import { useEffect, useState } from 'react';
import { onSnapshot, type Query } from 'firebase/firestore';

interface CollectionState<T> {
  data: T[];
  loading: boolean;
  error: Error | null;
}

/**
 * クエリ/コレクション参照を購読し、ドキュメント配列を返す。
 * deps が変わったら購読を張り替える（呼び出し側で安定した deps を渡すこと）。
 */
export function useCollection<T>(query: Query<T>, deps: unknown[] = []): CollectionState<T> {
  const [state, setState] = useState<CollectionState<T>>({
    data: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    setState((s) => ({ ...s, loading: true }));
    const unsub = onSnapshot(
      query,
      (snap) => setState({ data: snap.docs.map((d) => d.data()), loading: false, error: null }),
      (err) => setState({ data: [], loading: false, error: err }),
    );
    return unsub;
    // query 自体は毎回新規生成されるため、呼び出し側の deps に依存する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
