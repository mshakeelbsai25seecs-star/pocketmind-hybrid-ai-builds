import { RefreshCw } from 'lucide-react';

type RefreshButtonProps = {
  title: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
};

export default function RefreshButton({
  title,
  onClick,
  disabled,
  busy,
  className = '',
}: RefreshButtonProps) {
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={disabled || busy}
      className={`btn-secondary flex items-center gap-2 ${className}`.trim()}
      title={title}
    >
      <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
      {title}
    </button>
  );
}
