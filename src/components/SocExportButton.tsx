import { useState } from 'react';
import { CheckCircle2, Download } from 'lucide-react';
import { exportSocTextFile, type SocExportKind } from '../socLocalExport';

interface SocExportButtonProps {
  label: string;
  defaultFileName: string;
  contents: string;
  kind?: SocExportKind;
  className?: string;
  title?: string;
  disabled?: boolean;
  onStatus?: (message: string, ok: boolean) => void;
}

export default function SocExportButton({
  label,
  defaultFileName,
  contents,
  kind = 'md',
  className = 'btn-secondary',
  title,
  disabled,
  onStatus,
}: SocExportButtonProps) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const exportFile = async () => {
    if (saving || disabled) return;
    setSaving(true);
    setSaved(false);
    const result = await exportSocTextFile({ defaultFileName, contents, kind, title });
    setSaving(false);
    setSaved(result.ok);
    onStatus?.(result.message, result.ok);
    if (result.ok) window.setTimeout(() => setSaved(false), 1800);
  };

  return (
    <button type="button" onClick={exportFile} disabled={saving || disabled} className={`${className} flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed`} title={title || 'Exports are written locally only to paths under your configured NexusAI data roots.'}>
      {saved ? <CheckCircle2 className="w-4 h-4" /> : <Download className="w-4 h-4" />}
      {saving ? 'Saving...' : saved ? 'Saved' : label}
    </button>
  );
}
