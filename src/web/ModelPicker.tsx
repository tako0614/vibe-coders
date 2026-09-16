import { useId, useRef, useState } from 'react';
import { Check, CornerDownLeft, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import type { ModelChoice } from '../shared/models';

// Search text is a draft. Only choosing a result or confirming a custom ID saves it.
export function ModelPicker({
  value,
  onSelect,
  models,
  loading,
  error,
  reload,
  disabled = false,
}: {
  value: string;
  onSelect: (value: string) => void;
  models: ModelChoice[];
  loading: boolean;
  error: string;
  reload: () => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState(''),
    [index, setIndex] = useState(-1);
  const list = useRef<HTMLDivElement>(null);
  const text = query.trim();
  const choices =
    value && !models.some((m) => m.id === value) ? [{ id: value, name: value }, ...models] : models;
  const matches = choices.filter((m) =>
    `${m.id} ${m.name}`.toLocaleLowerCase().includes(text.toLocaleLowerCase()),
  );
  const visible = matches.slice(0, 80);
  const looksLikeKey = /^sk-[\w-]{20,}$/.test(text);
  const custom = text && !looksLikeKey && !choices.some((m) => m.id === text);
  const select = (model: string) => {
    if (!disabled) onSelect(model);
  };
  return (
    <div className="model-picker">
      <div className="model-search">
        <Search size={16} aria-hidden="true" />
        <input
          autoFocus
          name="model"
          role="combobox"
          aria-label="モデルを検索、またはモデルIDを入力"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={visible[index] ? `${id}-${index}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="検索、またはモデルIDを入力"
          value={query}
          maxLength={200}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(-1);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const next = visible.length
                ? Math.max(
                    0,
                    Math.min(visible.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)),
                  )
                : -1;
              setIndex(next);
              list.current
                ?.querySelectorAll('[role="option"]')
                [next]?.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (visible[index]) select(visible[index].id);
              else if (text && !looksLikeKey) select(text);
            }
          }}
        />
        <button
          type="button"
          aria-label="モデル一覧を再取得"
          title="モデル一覧を再取得"
          onClick={reload}
          disabled={loading || disabled}
        >
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
        </button>
      </div>
      {error && (
        <p className="model-picker-error" role="status">
          {error}
        </p>
      )}
      {looksLikeKey && (
        <p className="model-picker-error" role="alert">
          APIキーは「接続設定」の専用欄に入力してください。
        </p>
      )}
      <div
        id={`${id}-list`}
        ref={list}
        className="model-options"
        role="listbox"
        aria-label="利用できるモデル"
        aria-busy={loading}
      >
        {visible.map((m, i) => (
          <button
            key={m.id}
            id={`${id}-${i}`}
            type="button"
            role="option"
            aria-selected={value === m.id}
            className={i === index ? 'highlighted' : ''}
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => select(m.id)}
          >
            <span>
              <strong>{m.name}</strong>
              {m.name !== m.id && <small>{m.id}</small>}
            </span>
            {value === m.id ? (
              <Check size={16} />
            ) : m.isDefault ? (
              <small className="model-default">既定</small>
            ) : null}
          </button>
        ))}
        {loading && (
          <p className="model-list-note">
            <LoaderCircle size={14} className="spin" /> モデルを読み込み中…
          </p>
        )}
        {!loading && !visible.length && (
          <p className="model-list-note">
            {text ? '一致するモデルはありません' : 'モデルIDを入力して選択できます'}
          </p>
        )}
      </div>
      {custom && (
        <button
          type="button"
          className="model-custom"
          disabled={disabled}
          onClick={() => select(text)}
        >
          <CornerDownLeft size={15} />
          <span>
            <strong>{text}</strong> を使用
          </span>
        </button>
      )}
      {matches.length > visible.length && (
        <p className="model-list-note">全{matches.length}件。検索で絞り込めます。</p>
      )}
    </div>
  );
}
