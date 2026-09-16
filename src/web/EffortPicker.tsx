import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Gauge } from 'lucide-react';

const labels: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};
const descriptions: Record<string, string> = {
  none: '推論を使わずに応答',
  minimal: '最小限の推論',
  low: '応答の速さを優先',
  medium: '速さと深さのバランス',
  high: 'じっくり考える',
  xhigh: '複雑な問題をより深く検討',
  max: '十分な時間をかけて検討',
  ultra: '最も深く検討',
};
export function EffortPicker({
  value,
  efforts,
  defaultEffort,
  disabled,
  onChange,
}: {
  value: string;
  efforts: string[];
  defaultEffort?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const options = ['', ...new Set([...efforts, ...(value ? [value] : [])])];
  useEffect(() => {
    if (!open) return;
    const element = dialog.current!;
    element.showModal();
    const position = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop || 0;
      const bottom = Math.min(rect.top - 8, top + (viewport?.height || innerHeight) - 12);
      const width = Math.min(272, innerWidth - 24);
      element.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
      element.style.bottom = `${Math.max(12, innerHeight - bottom)}px`;
      element.style.maxHeight = `${Math.max(48, bottom - top - 12)}px`;
    };
    position();
    element.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
      element.close();
      trigger.current?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="model-label effort-trigger"
        aria-label={`推論の深さ: ${labels[value] || value || '自動'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={disabled ? '実行中・設定の更新中は変更できません' : '推論の深さ'}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Gauge size={14} />
        <span>{labels[value] || value || '自動'}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <dialog
          id={id}
          ref={dialog}
          className="effort-dialog"
          aria-label="推論の深さ"
          onClose={() => setOpen(false)}
          onClick={(e) => {
            if (e.target !== e.currentTarget) return;
            const rect = e.currentTarget.getBoundingClientRect();
            if (
              e.clientX < rect.left ||
              e.clientX > rect.right ||
              e.clientY < rect.top ||
              e.clientY > rect.bottom
            )
              setOpen(false);
          }}
        >
          <div className="effort-heading">推論の深さ</div>
          <div
            role="menu"
            aria-label="推論の深さ"
            onKeyDown={(e) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
              e.preventDefault();
              const buttons = Array.from(e.currentTarget.querySelectorAll('button'));
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? buttons.length - 1
                    : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }}
          >
            {options.map((option) => (
              <button
                type="button"
                key={option}
                role="menuitemradio"
                aria-checked={value === option}
                data-effort={option}
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
              >
                <span>
                  <strong>{labels[option] || option || '自動'}</strong>
                  <small>
                    {option
                      ? descriptions[option] || '保存済みの設定'
                      : `モデルの既定値${defaultEffort ? ` · ${labels[defaultEffort] || defaultEffort}` : ''}`}
                  </small>
                </span>
                {value === option && <Check size={16} aria-hidden="true" />}
              </button>
            ))}
          </div>
        </dialog>
      )}
    </>
  );
}
