import type { ContextBudgetResult } from '../contextBudget';
import { formatBudgetLabel } from '../contextBudget';

export default function ContextBudgetBar({
  budget,
  keepLastN,
  onKeepLastNChange,
  showSlider = true,
}: {
  budget: ContextBudgetResult;
  keepLastN: number;
  onKeepLastNChange?: (n: number) => void;
  showSlider?: boolean;
}) {
  const color =
    budget.level === 'critical'
      ? 'bg-red-500'
      : budget.level === 'warn'
        ? 'bg-amber-500'
        : 'bg-green-500';

  return (
    <div className="space-y-2 rounded-xl border border-surface-200 dark:border-surface-800 p-3 bg-white/70 dark:bg-surface-950/50">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-bold uppercase tracking-wider text-surface-500">Context</span>
        <span className={`font-semibold ${budget.level === 'critical' ? 'text-red-600 dark:text-red-400' : budget.level === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-surface-600 dark:text-surface-300'}`}>
          {formatBudgetLabel(budget)}
          {budget.droppedCount > 0 ? ` · dropped ${budget.droppedCount} older` : ''}
        </span>
      </div>
      <div className="h-2 rounded-full bg-surface-200 dark:bg-surface-800 overflow-hidden">
        <div className={`h-full transition-all ${color}`} style={{ width: `${Math.round(budget.ratio * 100)}%` }} />
      </div>
      {budget.level === 'critical' && (
        <p className="text-xs text-red-600 dark:text-red-400">
          Context is nearly full. Trim history or lower Memory window before sending.
        </p>
      )}
      {showSlider && onKeepLastNChange && (
        <label className="flex items-center gap-3 text-xs text-surface-500">
          <span className="whitespace-nowrap">Keep last {keepLastN} msgs</span>
          <input
            type="range"
            min={2}
            max={40}
            value={keepLastN}
            onChange={e => onKeepLastNChange(Number(e.target.value))}
            className="flex-1"
          />
        </label>
      )}
    </div>
  );
}
