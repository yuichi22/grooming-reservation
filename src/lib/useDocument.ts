// Firestore 単一ドキュメントを購読する軽量フック。
import { useEffect, useState } from 'react';
import { onSnapshot, type DocumentReference } from 'firebase/firestore';

interface DocState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

export function useDocument<T>(ref: DocumentReference<T>, deps: unknown[] = []): DocState<T> {
  const [state, setState] = useState<DocState<T>>({ data: null, loading: true, error: null });

  useEffect(() => {
    setState((s) => ({ ...s, loading: true }));
    const unsub = onSnapshot(
      ref,
      (snap) => setState({ data: snap.exists() ? snap.data() : null, loading: false, error: null }),
      (err) => setState({ data: null, loading: false, error: err }),
    );
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
