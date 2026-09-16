import { useId, useState } from 'react';
import { ChevronDown, Check, RefreshCw } from 'lucide-react';
import type { ModelChoice } from '../shared/models';

export function ModelPicker({
  value,
  onChange,
  models,
  loading,
  error,
  reload,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  models: ModelChoice[];
  loading: boolean;
  error: string;
  reload: () => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false),
    [searching, setSearching] = useState(false),
    [index, setIndex] = useState(-1);
  const query = searching ? value.toLocaleLowerCase() : '';
  const matches = models.filter((m) => `${m.id} ${m.name}`.toLocaleLowerCase().includes(query));
  const visible = matches.slice(0, 80);
  const select = (model: ModelChoice) => {
    onChange(model.id);
    setOpen(false);
    setSearching(false);
    setIndex(-1);
  };
  return (
    <div
      className="model-picker"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <div className="model-picker-label">
        <label htmlFor={id}>モデル</label>
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
      <div className="model-picker-input">
        <input
          id={id}
          name="model"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && visible[index] ? `${id}-${index}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="一覧から選択、またはモデル名を入力"
          value={value}
          required
          maxLength={200}
          disabled={disabled}
          onFocus={() => {
            setOpen(true);
            setSearching(false);
            setIndex(-1);
          }}
          onChange={(e) => {
            onChange(e.target.value);
            setSearching(true);
            setOpen(true);
            setIndex(-1);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setOpen(true);
              setIndex((i) =>
                visible.length
                  ? Math.max(0, Math.min(visible.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))
                  : -1,
              );
            } else if (e.key === 'Enter' && open && visible[index]) {
              e.preventDefault();
              select(visible[index]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
            }
          }}
        />
        <button
          type="button"
          aria-label="モデル一覧を開く"
          disabled={disabled}
          onClick={() => {
            setSearching(false);
            setIndex(-1);
            setOpen(true);
          }}
        >
          <ChevronDown size={16} />
        </button>
      </div>
      {open && (
        <div className="model-picker-menu">
          <div id={`${id}-list`} role="listbox" aria-label="利用できるモデル">
            {visible.map((m, i) => (
              <button
                key={m.id}
                id={`${id}-${i}`}
                type="button"
                role="option"
                aria-selected={value === m.id}
                className={i === index ? 'highlighted' : ''}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(m)}
              >
                <span>
                  <strong>
                    {m.name}
                    {m.isDefault ? ' · 既定' : ''}
                  </strong>
                  <code>{m.id}</code>
                </span>
                {value === m.id && <Check size={15} />}
              </button>
            ))}
          </div>
          {!visible.length && (
            <p>
              {loading
                ? 'モデル一覧を取得中…'
                : value
                  ? '一覧にないモデル名も、そのまま使用できます。'
                  : 'モデル名を直接入力できます。'}
            </p>
          )}
          {matches.length > visible.length && (
            <p>名前を入力して絞り込めます（全{matches.length}件）</p>
          )}
        </div>
      )}
      {error && (
        <p className="model-picker-error" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
