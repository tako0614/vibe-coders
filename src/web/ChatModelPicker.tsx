import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LoaderCircle, Settings2, X } from 'lucide-react';
import { api, type Status } from './api';
import type { Action } from './App';
import type { ModelChoice } from '../shared/models';
import { ModelPicker } from './ModelPicker';

export function ChatModelPicker({
  status,
  action,
  onSettings,
}: {
  status: Status;
  action: Action;
  onSettings: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null),
    dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false);
  const [models, setModels] = useState<ModelChoice[]>([]),
    [error, setError] = useState(''),
    [saveError, setSaveError] = useState(''),
    [reload, setReload] = useState(0);
  const provider = status.config.provider;
  const codex = !provider || provider.kind === 'codex';
  const ready = codex
    ? status.codex?.subscriptionReady
    : !provider!.keyRequired || status.providerKeySaved;
  const working = status.conversations.some((c) => c.state === 'running');
  const name = codex ? 'Codex' : provider!.baseUrl.includes('openrouter.ai') ? 'OpenRouter' : 'API';
  const close = () => {
    dialog.current?.close();
    setOpen(false);
  };
  useEffect(() => {
    if (open && codex && status.codex?.state === 'unchecked')
      void api('/codex/auth/refresh', 'POST', {}).catch(() => {});
  }, [open, codex, status.codex?.state]);
  useEffect(() => {
    if (!open) return;
    const element = dialog.current!;
    element.showModal();
    const position = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const viewport = window.visualViewport;
      const visibleTop = viewport?.offsetTop || 0;
      const bottom = Math.min(
        rect.top - 8,
        visibleTop + (viewport?.height || window.innerHeight) - 12,
      );
      element.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - Math.min(380, window.innerWidth - 24) - 12))}px`;
      element.style.bottom = `${Math.max(12, window.innerHeight - bottom)}px`;
      element.style.maxHeight = `${Math.max(160, Math.min(480, bottom - visibleTop - 12))}px`;
    };
    position();
    element.querySelector<HTMLInputElement>('input')?.focus();
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
      element.close();
    };
  }, [open]);
  useEffect(() => {
    if (!ready) return;
    let current = true;
    setLoading(true);
    setError('');
    setModels([]);
    void (
      codex
        ? api<ModelChoice[]>('/codex/models')
        : api<ModelChoice[]>('/config/provider/models', 'POST', { baseUrl: provider!.baseUrl })
    )
      .then((value) => {
        if (current) setModels(value);
      })
      .catch(() => {
        if (current) setError('一覧を取得できませんでした。モデルIDを直接入力することもできます。');
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [ready, codex, provider?.baseUrl, provider?.revision, reload]);
  const choose = (model: string) => {
    if (saving || working || !ready) return;
    if (model === provider?.model) return close();
    void action(async () => {
      setSaving(true);
      setSaveError('');
      try {
        await api('/config/provider', 'PUT', {
          revision: status.config.revision,
          provider: {
            kind: codex ? 'codex' : 'openai',
            baseUrl: codex ? 'https://chatgpt.com/backend-api/codex' : provider!.baseUrl,
            model,
            supportsImages: provider?.supportsImages ?? true,
            keyRequired: codex ? false : provider!.keyRequired,
          },
        });
        close();
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : 'モデルを変更できませんでした。');
      } finally {
        setSaving(false);
      }
    });
  };
  const choice = models.find((m) => m.id === provider?.model);
  const efforts = choice?.reasoningEfforts || [];
  const setEffort = (reasoningEffort: string) => {
    if (!provider || saving || working) return;
    setSaving(true);
    void action(async () => {
      const { revision: _revision, reasoningEffort: _effort, ...value } = provider;
      await api('/config/provider', 'PUT', {
        revision: status.config.revision,
        provider: { ...value, ...(reasoningEffort ? { reasoningEffort } : {}) },
      });
    }).finally(() => setSaving(false));
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="model-label"
        aria-label="モデルを選択"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={working ? '実行が完了するとモデルを変更できます' : 'モデルを選択'}
        disabled={working}
        onClick={() => setOpen(true)}
      >
        <span>{provider?.model || 'モデルを選択'}</span>
        <ChevronDown size={14} />
      </button>
      {(efforts.length > 0 || provider?.reasoningEffort) && (
        <label className="effort-picker">
          <span>Effort</span>
          <select
            aria-label="推論の深さ"
            value={provider?.reasoningEffort || ''}
            disabled={working || saving || loading}
            onChange={(e) => setEffort(e.target.value)}
          >
            <option value="">
              自動{choice?.defaultReasoningEffort ? ` (${choice.defaultReasoningEffort})` : ''}
            </option>
            {provider?.reasoningEffort && !efforts.includes(provider.reasoningEffort) && (
              <option value={provider.reasoningEffort}>{provider.reasoningEffort}（保存値）</option>
            )}
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
      )}
      {open && (
        <dialog
          ref={dialog}
          className="chat-model-dialog"
          aria-label="モデルを選択"
          onClose={() => setOpen(false)}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              const r = e.currentTarget.getBoundingClientRect();
              if (
                e.clientX < r.left ||
                e.clientX > r.right ||
                e.clientY < r.top ||
                e.clientY > r.bottom
              )
                close();
            }
          }}
        >
          <div className="model-dialog-heading">
            <strong>モデルを選択</strong>
            <span>{name}</span>
            {saving && <LoaderCircle size={14} className="spin" />}
            <button
              type="button"
              className="icon-button"
              aria-label="モデル選択を閉じる"
              onClick={close}
            >
              <X size={16} />
            </button>
          </div>
          <p className="model-scope-note">すべての会話で使用するモデル</p>
          {ready ? (
            <ModelPicker
              value={provider?.model || ''}
              onSelect={choose}
              models={models}
              loading={loading}
              error={saveError || error}
              reload={() => setReload((n) => n + 1)}
              disabled={saving || working}
            />
          ) : (
            <p className="model-setup-note">
              {codex
                ? 'Codexの認証を確認するか、APIキーを登録して始めましょう。'
                : '接続設定でAPIキーを登録してください。'}
            </p>
          )}
          <button
            type="button"
            className="model-settings-link"
            onClick={() => {
              close();
              onSettings();
            }}
          >
            <Settings2 size={14} /> 接続設定<span>認証・APIキー</span>
          </button>
        </dialog>
      )}
    </>
  );
}
