import type { SocNavId } from './SocActiveCaseContext';

const GROUPS: { title: string; items: { id: SocNavId; label: string }[] }[] = [
  {
    title: 'Alert Analyst',
    items: [
      { id: 'queue', label: 'Queue' },
      { id: 'case', label: 'Case' },
      { id: 'import', label: 'Import' },
      { id: 'memory', label: 'Memory' },
      { id: 'metrics', label: 'Metrics' },
    ],
  },
  {
    title: 'Engineering',
    items: [
      { id: 'knowledge', label: 'Knowledge' },
      { id: 'workspace', label: 'Workspace' },
      { id: 'validators', label: 'Validators' },
      { id: 'reports', label: 'Reports' },
      { id: 'practice', label: 'Practice' },
    ],
  },
  {
    title: 'Settings',
    items: [
      { id: 'connectors', label: 'Connectors' },
      { id: 'security', label: 'Security' },
    ],
  },
];

export default function SocNav({
  nav,
  onNavigate,
  caseSelected,
}: {
  nav: SocNavId;
  onNavigate: (id: SocNavId) => void;
  caseSelected: boolean;
}) {
  return (
    <nav className="w-48 shrink-0 border-r border-surface-200 dark:border-surface-800 py-3 px-2 space-y-4 overflow-y-auto">
      {GROUPS.map(group => (
        <div key={group.title}>
          <p className="px-2 mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">
            {group.title}
          </p>
          <div className="space-y-0.5">
            {group.items.map(item => {
              const disabled = item.id === 'case' && !caseSelected;
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => onNavigate(item.id)}
                  className={`w-full text-left px-3 py-2 rounded-xl text-sm ${
                    nav === item.id
                      ? 'bg-primary-500/15 text-primary-700 dark:text-primary-300 font-semibold'
                      : disabled
                        ? 'text-surface-400 cursor-not-allowed'
                        : 'text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
