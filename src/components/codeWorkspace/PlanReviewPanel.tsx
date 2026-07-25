import { useEffect, useState } from 'react';
import { Hammer, Save, Trash2 } from 'lucide-react';
import type { PocketCodePlan } from '../../codeWorkspace/types';

export default function PlanReviewPanel({
  plan,
  busy,
  onBuild,
  onSave,
  onDiscard,
  onChangeMarkdown,
}: {
  plan: PocketCodePlan;
  busy?: boolean;
  onBuild: () => void;
  onSave: (markdown: string) => void;
  onDiscard: () => void;
  onChangeMarkdown?: (markdown: string) => void;
}) {
  const [markdown, setMarkdown] = useState(plan.markdown);

  useEffect(() => {
    setMarkdown(plan.markdown);
  }, [plan.id, plan.markdown]);

  return (
    <div className="rounded-xl border border-primary-200 dark:border-primary-900/50 bg-primary-50/40 dark:bg-primary-950/20 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-bold text-primary-800 dark:text-primary-200 truncate">
            Plan · {plan.title}
          </p>
          <p className="text-[10px] text-surface-500">
            {plan.status} · {plan.todos.length} todos · review then Build
          </p>
        </div>
      </div>

      {plan.todos.length > 0 && (
        <ul className="text-[11px] space-y-0.5 text-surface-600 dark:text-surface-300">
          {plan.todos.map(t => (
            <li key={t.id} className="flex gap-1.5">
              <span className="opacity-50">☐</span>
              <span>{t.text}</span>
            </li>
          ))}
        </ul>
      )}

      <textarea
        value={markdown}
        onChange={e => {
          setMarkdown(e.target.value);
          onChangeMarkdown?.(e.target.value);
        }}
        rows={10}
        className="input-field w-full text-xs font-mono resize-y min-h-[8rem]"
        disabled={busy}
      />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onBuild}
          className="btn-primary text-xs flex items-center gap-1.5"
        >
          <Hammer className="w-3.5 h-3.5" /> Build
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onSave(markdown)}
          className="btn-secondary text-xs flex items-center gap-1.5"
        >
          <Save className="w-3.5 h-3.5" /> Save
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDiscard}
          className="btn-secondary text-xs flex items-center gap-1.5 text-red-600"
        >
          <Trash2 className="w-3.5 h-3.5" /> Discard
        </button>
      </div>
    </div>
  );
}
