import { useEffect, useRef, useState } from 'react';
import type { ComposerDraft } from './Chat';

const open = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('vibe-coders-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
async function stored(key: string, value?: ComposerDraft) {
  const db = await open();
  try {
    return await new Promise<ComposerDraft | undefined>((resolve, reject) => {
      const transaction = db.transaction('drafts', value === undefined ? 'readonly' : 'readwrite');
      const records = transaction.objectStore('drafts');
      const request =
        value === undefined
          ? records.get(key)
          : value.text || value.images.length
            ? records.put(value, key)
            : records.delete(key);
      transaction.oncomplete = () => resolve(value === undefined ? request.result : value);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
// Serialize by storage key across component unmounts, so an older write cannot
// resurrect a draft after a send or a fast view switch.
const writes = new Map<string, Promise<unknown>>();
function save(key: string, value: ComposerDraft) {
  const previous = writes.get(key) || Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(() => stored(key, value))
    .finally(() => {
      if (writes.get(key) === task) writes.delete(key);
    });
  writes.set(key, task);
  return task;
}
export function useComposerDraft(key: string, id: string, cache: Map<string, ComposerDraft>) {
  const initial = cache.get(id) || { text: '', images: [] };
  const [draft, setDraft] = useState(initial),
    [error, setError] = useState('');
  const current = useRef(initial),
    edited = useRef(false);
  useEffect(() => {
    let disposed = false;
    if (!cache.has(id))
      void (writes.get(key) || Promise.resolve())
        .catch(() => {})
        .then(() => stored(key))
        .then((value) => {
          if (!disposed && !edited.current && value) {
            current.current = value;
            cache.set(id, value);
            setDraft(value);
          }
        })
        .catch(() => {
          if (!disposed)
            setError('下書きを読み込めません。このブラウザの保存設定を確認してください。');
        });
    return () => {
      disposed = true;
    };
  }, [key, id, cache]);
  const update = (patch: Partial<ComposerDraft> | ((value: ComposerDraft) => ComposerDraft)) => {
    edited.current = true;
    const next =
      typeof patch === 'function' ? patch(current.current) : { ...current.current, ...patch };
    current.current = next;
    cache.set(id, next);
    setDraft(next);
    return save(key, next)
      .then(() => setError(''))
      .catch(() => {
        setError('下書きを保存できません。保存容量・ブラウザ設定を確認してください。');
      });
  };
  return {
    draft,
    update,
    clear: () => update({ text: '', images: [], operationId: undefined }),
    error,
  };
}
