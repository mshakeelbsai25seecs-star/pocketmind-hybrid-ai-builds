import { useEffect, useState } from 'react';
import { FileText, Loader2, Save, Sparkles, AlertTriangle } from 'lucide-react';
import { save } from '@tauri-apps/api/dialog';
import { useAppStore } from '../store';
import {
  exportDocument,
  generateDocumentSpec,
  installDocExportSupport,
  pickChatBackend,
  probeDocExport,
  type DocFormatId,
  type DocExportProbe,
  type DocSpecResult,
} from '../docStudio';

const FORMATS: { id: DocFormatId; label: string }[] = [
  { id: 'docx', label: 'DOCX' },
  { id: 'pptx', label: 'PPTX' },
  { id: 'pdf', label: 'PDF' },
];

function defaultPath(title: string, format: DocFormatId): string {
  const exportDir = useAppStore.getState().deploymentConfig?.exportDir
    || useAppStore.getState().deploymentConfig?.dataRoot
    || '';
  const base = (title || 'document')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'document';
  const name = base.toLowerCase().endsWith(`.${format}`) ? base : `${base}.${format}`;
  if (!exportDir) return name;
  const sep = exportDir.includes('/') ? '/' : '\\';
  return `${exportDir.replace(/[\\/]+$/, '')}${sep}${name}`;
}

export default function DocumentStudio() {
  const currentModel = useAppStore(s => s.currentModel);
  const defaultParams = useAppStore(s => s.defaultParams);
  const [brief, setBrief] = useState('Create a one-page project status update with goals, progress, risks, and next steps.');
  const [format, setFormat] = useState<DocFormatId>('docx');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [specResult, setSpecResult] = useState<DocSpecResult | null>(null);
  const [probe, setProbe] = useState<DocExportProbe | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [installBusy, setInstallBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setProbe(await probeDocExport());
      } catch {
        /* optional */
      }
    })();
  }, []);

  const installExportSupport = async () => {
    setInstallBusy(true);
    setErr(null);
    setMsg('Installing python-docx, python-pptx, and reportlab…');
    try {
      const next = await installDocExportSupport();
      setProbe(next);
      setMsg(next.ready ? 'Document export support installed.' : 'Install finished — recheck exporter status above.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setMsg(null);
      try {
        setProbe(await probeDocExport());
      } catch {
        /* optional */
      }
    } finally {
      setInstallBusy(false);
    }
  };

  const modelLabel = currentModel || 'No model selected';
  const { backend, modelPath } = pickChatBackend(currentModel);

  const generate = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      if (!brief.trim()) {
        setErr('Enter a brief or outline first.');
        return;
      }
      if (!modelPath && backend === 'llama.cpp') {
        setErr('Select a model in Models (local, online, or org) before generating.');
        return;
      }
      const result = await generateDocumentSpec({
        brief: brief.trim(),
        format,
        backend,
        modelPath,
        params: defaultParams,
      });
      setSpecResult(result);
      setMsg(result.message);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveAs = async () => {
    if (!specResult?.spec) {
      setErr('Generate a document outline first.');
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const title = String((specResult.spec as { title?: string }).title || 'document');
      const selected = await save({
        title: `Save ${format.toUpperCase()}`,
        defaultPath: defaultPath(title, format),
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!selected) {
        setMsg('Save cancelled.');
        return;
      }
      const exported = await exportDocument(specResult.spec, format, selected);
      setMsg(exported.message + (exported.path ? ` → ${exported.path}` : ''));
      setRecent(prev => [exported.path, ...prev.filter(p => p !== exported.path)].slice(0, 8));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 sm:p-8 space-y-6 bg-gradient-to-br from-surface-50 via-white to-primary-50/30 dark:from-surface-950 dark:via-surface-950 dark:to-primary-950/20">
      <section className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white/80 dark:bg-surface-900/80 backdrop-blur p-6 sm:p-8 shadow-soft">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 text-sm font-semibold mb-4">
          <FileText className="w-4 h-4" /> Document Studio
        </div>
        <h1 className="text-3xl font-black tracking-tight">Create DOCX, PPTX, and PDF offline</h1>
        <p className="text-surface-600 dark:text-surface-400 mt-2 max-w-3xl text-sm">
          Your current answer model writes a structured outline; Python exporters on this PC write the real Office/PDF file. Online models only generate the outline — files stay local.
        </p>
        <p className="text-xs text-surface-500 mt-3">Model: {modelLabel}</p>
      </section>

      {probe && !probe.ready && (
        <div className="rounded-2xl border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm flex gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
          <div className="flex-1">
            <p className="font-medium">Exporter packages incomplete</p>
            <p className="text-xs text-surface-600 dark:text-surface-400 mt-1">
              Install with: pip install python-docx python-pptx reportlab
              {!probe.python_found ? ' (Python not found on PATH)' : ''}
              {!probe.worker_found ? ' · exporter script missing' : ''}
            </p>
            <button
              type="button"
              className="btn-primary text-xs mt-3"
              disabled={installBusy}
              onClick={() => void installExportSupport()}
            >
              {installBusy ? <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> : null}
              Install document export support
            </button>
          </div>
        </div>
      )}

      <section className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-6 space-y-4 shadow-soft">
        <label className="block text-sm">
          <span className="text-xs text-surface-500">Brief / outline</span>
          <textarea
            className="mt-1 w-full input min-h-[8rem]"
            value={brief}
            onChange={e => setBrief(e.target.value)}
            placeholder="Describe the document you want…"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          {FORMATS.map(f => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFormat(f.id)}
              className={`px-3 py-1.5 rounded-xl text-sm border transition-colors ${
                format === f.id
                  ? 'bg-primary-600 text-white border-primary-600'
                  : 'border-surface-200 dark:border-surface-700 hover:bg-surface-100 dark:hover:bg-surface-800'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary flex items-center gap-2" disabled={busy} onClick={() => void generate()}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Generate outline
          </button>
          <button type="button" className="btn-secondary flex items-center gap-2" disabled={busy || !specResult} onClick={() => void saveAs()}>
            <Save className="w-4 h-4" />
            Save as {format.toUpperCase()}
          </button>
        </div>
        {msg && <p className="text-sm text-emerald-600 dark:text-emerald-300">{msg}</p>}
        {err && <p className="text-sm text-red-600 dark:text-red-300">{err}</p>}
      </section>

      {specResult && (
        <section className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-6 shadow-soft">
          <h2 className="text-lg font-bold mb-3">Preview</h2>
          <pre className="whitespace-pre-wrap text-sm text-surface-700 dark:text-surface-300 font-sans max-h-[28rem] overflow-y-auto">
            {specResult.preview_markdown}
          </pre>
        </section>
      )}

      {recent.length > 0 && (
        <section className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-6 shadow-soft">
          <h2 className="text-lg font-bold mb-3">Recent exports</h2>
          <ul className="space-y-2 text-xs text-surface-600 dark:text-surface-400 break-all">
            {recent.map(p => <li key={p}>{p}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
