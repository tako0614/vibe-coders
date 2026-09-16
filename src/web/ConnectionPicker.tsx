import { useEffect, useRef } from 'react';
import { Check, Plus } from 'lucide-react';
import type { Status } from './api';

export function ConnectionPicker({
  status,
  value,
  onChange,
  disabled = false,
  allowAdd = false,
}: {
  status: Status;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  allowAdd?: boolean;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const selected = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>('button[data-provider]') || [],
    ).find((button) => button.dataset.provider === value);
    selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);
  return (
    <div ref={list} className="connection-picker" role="group" aria-label="接続先">
      {status.providers.map((connection) => (
        <button
          type="button"
          key={connection.id}
          data-provider={connection.id}
          aria-pressed={value === connection.id}
          disabled={disabled}
          onClick={() => onChange(connection.id)}
          title={connection.name}
        >
          <span>
            <strong>{connection.name}</strong>
            <small>
              {connection.provider.kind === 'codex'
                ? status.codex?.subscriptionReady
                  ? '端末の認証を使用'
                  : '認証が必要'
                : connection.credentialSaved
                  ? 'APIキー保存済み'
                  : !connection.provider.keyRequired
                    ? 'APIキー不要'
                    : 'APIキー未登録'}
            </small>
          </span>
          {value === connection.id && <Check size={14} aria-hidden="true" />}
        </button>
      ))}
      {allowAdd && (
        <button
          type="button"
          data-provider="new"
          aria-pressed={value === 'new'}
          disabled={disabled}
          onClick={() => onChange('new')}
        >
          <Plus size={15} />
          <span>
            <strong>接続先を追加</strong>
            <small>OpenAI互換API</small>
          </span>
        </button>
      )}
    </div>
  );
}
