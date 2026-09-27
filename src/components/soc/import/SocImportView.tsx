import { useState } from 'react';
import { open } from '@tauri-apps/api/dialog';
import { readTextFile } from '@tauri-apps/api/fs';
import { caseFromParsedAlert } from '../../../soc/caseFactory';
import { newImportBatchId } from '../../../soc/ids';
import { parseImportFiles, type SocImportFormat } from '../../../soc/import';
import {
  socListCases,
  socSaveImportBatch,
  socUpsertCase,
  socWriteCaseImportBlob,
} from '../../../soc/caseStore';
import type { ParsedAlert } from '../../../soc/types';
import { useSocActiveCase } from '../SocActiveCaseContext';

export default function SocImportView() {
  const { refreshIndex, setActiveCaseId, setNav, setStatus, busy, setBusy } = useSocActiveCase();
  const [format, setFormat] = useState<SocImportFormat>('auto');
  const [preview, setPreview] = useState<ParsedAlert[]>([]);
  const [errors, setErrors] = useState<{ file: string; row?: number; message: string }[]>([]);
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const [pasteText, setPasteText] = useState('');

  const applyLoaded = (loaded: { name: string; text: string }[]) => {
    setFiles(loaded);
    const parsed = parseImportFiles(loaded, format);
    setPreview(parsed.alerts.slice(0, 500));
    setErrors(parsed.errors);
    setStatus(`Parsed ${parsed.alerts.length} alert(s) from ${loaded.length} file(s).`);
  };

  const pickFiles = async () => {
    setStatus(null);
    const selected = await open({
      multiple: true,
      filters: [{ name: 'Alert exports', extensions: ['json', 'jsonl', 'xml', 'csv', 'txt', 'log', 'cef'] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    setBusy(true);
    try {
      const loaded: { name: string; text: string }[] = [];
      for (const path of paths) {
        const text = await readTextFile(path);
        const name = path.split(/[/\\]/).pop() || path;
        loaded.push({ name, text });
      }
      applyLoaded(loaded);
    } catch (err) {
      // Browser / missing dialog: allow HTML file input fallback message
      setStatus(`${String(err)} Use paste below if the file picker is unavailable.`);
    } finally {
      setBusy(false);
    }
  };

  const onHtmlFile = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    try {
      const loaded: { name: string; text: string }[] = [];
      for (const file of Array.from(list)) {
        loaded.push({ name: file.name, text: await file.text() });
      }
      applyLoaded(loaded);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  const parsePaste = () => {
    if (!pasteText.trim()) {
      setStatus('Paste alert export text first.');
      return;
    }
    applyLoaded([{ name: 'pasted-alert.txt', text: pasteText }]);
  };

  const reparse = () => {
    if (!files.length) return;
    const parsed = parseImportFiles(files, format);
    setPreview(parsed.alerts.slice(0, 500));
    setErrors(parsed.errors);
    setStatus(`Parsed ${parsed.alerts.length} alert(s).`);
  };

  const commit = async () => {
    if (!preview.length && !files.length) {
      setStatus('Nothing to import.');
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const parsed = parseImportFiles(files, format);
      const batchId = newImportBatchId();
      const existing = await socListCases();
      const openExternal = new Set(
        existing
          .filter(e => e.status !== 'closed' && e.external_id)
          .map(e => e.external_id as string),
      );
      const createdIds: string[] = [];
      const commitErrors = [...parsed.errors];

      for (const alert of parsed.alerts) {
        if (alert.externalId && openExternal.has(alert.externalId)) {
          commitErrors.push({
            file: alert.sourceLabel,
            message: `Skipped duplicate open case for external id ${alert.externalId}`,
          });
          continue;
        }
        let socCase = caseFromParsedAlert(alert, { importBatchId: batchId });
        socCase = await socUpsertCase(socCase);
        if (alert.originalPayload) {
          const path = await socWriteCaseImportBlob(
            socCase.id,
            alert.sourceLabel.replace(/[^\w.\-]+/g, '_') || 'payload.txt',
            alert.originalPayload,
          );
          socCase = await socUpsertCase({ ...socCase, importPayloadPath: path });
        }
        createdIds.push(socCase.id);
        if (alert.externalId) openExternal.add(alert.externalId);
      }

      await socSaveImportBatch({
        id: batchId,
        at: Date.now(),
        files: files.map(f => f.name),
        createdCaseIds: createdIds,
        errors: commitErrors,
      });
      await refreshIndex();
      setErrors(commitErrors);
      setPreview([]);
      setFiles([]);
      if (createdIds[0]) {
        setActiveCaseId(createdIds[0]);
        setNav('queue');
      }
      setStatus(`Imported ${createdIds.length} case(s). ${commitErrors.length} warning(s).`);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wide text-surface-500">Format</span>
          <select
            className="input-field mt-1 text-sm"
            value={format}
            onChange={e => setFormat(e.target.value as SocImportFormat)}
          >
            <option value="auto">Auto-detect</option>
            <option value="fortisiem_json">FortiSIEM JSON</option>
            <option value="fortisiem_xml">FortiSIEM XML</option>
            <option value="generic_cef">CEF</option>
            <option value="generic_csv">CSV</option>
            <option value="raw_bundle">Raw file → one case</option>
          </select>
        </label>
        <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => void pickFiles()}>
          Choose files
        </button>
        <label className="btn-secondary text-sm cursor-pointer inline-flex items-center">
          Browse
          <input
            type="file"
            className="hidden"
            multiple
            accept=".json,.jsonl,.xml,.csv,.txt,.log,.cef"
            onChange={e => void onHtmlFile(e.target.files)}
          />
        </label>
        <button type="button" className="btn-secondary text-sm" disabled={busy || !files.length} onClick={reparse}>
          Re-parse
        </button>
        <button type="button" className="btn-primary text-sm" disabled={busy || !files.length} onClick={() => void commit()}>
          Import into queue
        </button>
      </div>

      <div className="space-y-2">
        <textarea
          className="input-field font-mono text-xs min-h-[6rem]"
          value={pasteText}
          onChange={e => setPasteText(e.target.value)}
          placeholder="Or paste FortiSIEM JSON / CEF / CSV / XML here"
        />
        <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={parsePaste}>
          Parse paste
        </button>
      </div>

      {!!errors.length && (
        <div className="rounded-xl border border-amber-300/70 dark:border-amber-800 p-3 text-sm space-y-1">
          {errors.slice(0, 40).map((err, i) => (
            <p key={`${err.file}-${i}`}>{err.file}: {err.message}</p>
          ))}
        </div>
      )}

      {preview.length === 0 ? (
        <p className="text-sm text-surface-500">Choose export files to preview alerts before import.</p>
      ) : (
        <div className="rounded-2xl border border-surface-200 dark:border-surface-800 overflow-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-surface-500">
              <tr>
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">Severity</th>
                <th className="px-3 py-2">External ID</th>
                <th className="px-3 py-2">Source IP</th>
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2">File</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((alert, i) => (
                <tr key={`${alert.externalId || alert.title}-${i}`} className="border-t border-surface-100 dark:border-surface-800">
                  <td className="px-3 py-2">{alert.title}</td>
                  <td className="px-3 py-2">{alert.severity}</td>
                  <td className="px-3 py-2">{alert.externalId || '—'}</td>
                  <td className="px-3 py-2">{alert.entities.sourceIp || '—'}</td>
                  <td className="px-3 py-2">{alert.entities.username || '—'}</td>
                  <td className="px-3 py-2">{alert.sourceLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
