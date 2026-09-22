import { RefreshCw } from 'lucide-react';

type RefreshButtonProps = {
  title: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
  /** Icon-only control; `title` is used as the accessible label / tooltip. */
  iconOnly?: boolean;
};

export default function RefreshButton({
  title,
  onClick,
  disabled,
  busy,
  className = '',
  iconOnly = false,
}: RefreshButtonProps) {
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={disabled || busy}
      className={`btn-secondary flex items-center ${iconOnly ? 'justify-center p-2' : 'gap-2'} ${className}`.trim()}
      title={title}
      aria-label={title}
    >
      <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
      {!iconOnly && title}
    </button>
  );
}
