import {
  MODE_LABELS,
  POCKETCODE_MODES,
  type PocketCodeAgentMode,
} from '../../codeWorkspace/agentModes';

export default function ModePicker({
  mode,
  disabled,
  onChange,
}: {
  mode: PocketCodeAgentMode;
  disabled?: boolean;
  onChange: (mode: PocketCodeAgentMode) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1" role="tablist" aria-label="PocketCode mode">
      {POCKETCODE_MODES.map(m => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={mode === m}
          disabled={disabled}
          onClick={() => onChange(m)}
          className={`px-2.5 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wide transition-colors ${
            mode === m
              ? 'bg-primary-100 dark:bg-primary-950/50 text-primary-800 dark:text-primary-200'
              : 'text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-800'
          } disabled:opacity-50`}
        >
          {MODE_LABELS[m]}
        </button>
      ))}
      <span className="text-[10px] text-surface-400 self-center ml-1 hidden sm:inline">Shift+Tab</span>
    </div>
  );
}
