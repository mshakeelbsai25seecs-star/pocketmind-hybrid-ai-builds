import { useMemo, useState } from 'react';
import {
  CheckCircle2, ClipboardCopy, Copy, FileText, Loader2,
  Layers, ListChecks, Send, ShieldCheck, Sparkles,
} from 'lucide-react';
import { useAppStore } from '../store';
import { useKnowledgeChatStore } from '../knowledgeChat/store';
import SocExportButton from './SocExportButton';
import SocRetrievedSources from './SocRetrievedSources';
import { useSocGroundedKnowledge } from '../hooks/useSocGroundedKnowledge';
import type { SocWorkspaceInput } from '../socPromptTemplates';
import { flattenSocChunks } from '../socKnowledgeIndex';
import { generateSocGroundedReport } from '../socGroundedGeneration';
import { logAuditEvent } from '../auditLog';
import { SOC_SYSTEM_PROMPT } from '../socChatHandoff';
import {
  buildSocArtifactReport,
  defaultSocArtifactReportTitle,
  emptySocArtifactReportInput,
  SOC_ARTIFACT_REPORT_TYPES,
  type SocArtifactReportInput,
  type SocArtifactReportType,
} from '../socReportTemplates';

interface SocReportsProps {
  workspaceInput: SocWorkspaceInput;
  generatedPrompt: string;
}

function compactReportText(value: string, max = 900): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

function fieldLabel(label: string, children: React.ReactNode) {
  return (
    <label className="block">
      <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500 dark:text-surface-400">{label}</span>
      {children}
    </label>
  );
}

export default function SocReports({ workspaceInput, generatedPrompt }: SocReportsProps) {
  const [form, setForm] = useState<SocArtifactReportInput>(emptySocArtifactReportInput);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [aiGeneratedReport, setAiGeneratedReport] = useState<string | null>(null);

  const {
    socKnowledgeResources,
    selectedSocKnowledgeResourceIds,
    selectedSocKnowledgeChunkIds,
    socKnowledgeCollectionId,
    currentModel,
    defaultParams,
    setPendingChatPrompt,
    setActiveView,
    setSidebarOpen,
  } = useAppStore();
  const { embeddingModelPath, retrievalMode, topK } = useKnowledgeChatStore();

  const grounded = useSocGroundedKnowledge({
    action: 'knowledge',
    workspaceInput,
    reportType: form.reportType,
  });

  const selectedResources = useMemo(() => {
    const selected = new Set(selectedSocKnowledgeResourceIds);
    return socKnowledgeResources.filter(resource => selected.has(resource.id));
  }, [socKnowledgeResources, selectedSocKnowledgeResourceIds]);

  const selectedChunks = useMemo(() => {
    const selected = new Set(selectedSocKnowledgeChunkIds);
    return flattenSocChunks(socKnowledgeResources).filter(chunk => selected.has(chunk.id));
  }, [socKnowledgeResources, selectedSocKnowledgeChunkIds]);

  const templateReport = useMemo(
    () => buildSocArtifactReport(
      form,
      workspaceInput,
      selectedResources,
      selectedChunks,
      generatedPrompt,
      grounded.contextHits,
    ),
    [form, workspaceInput, selectedResources, selectedChunks, generatedPrompt, grounded.contextHits],
  );

  const report = aiGeneratedReport || templateReport;

  const update = <K extends keyof SocArtifactReportInput>(key: K, value: SocArtifactReportInput[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
    setAiGeneratedReport(null);
  };

  const changeType = (type: SocArtifactReportType) => {
    setForm(prev => ({
      ...prev,
      reportType: type,
      reportTitle: !prev.reportTitle.trim() || prev.reportTitle === defaultSocArtifactReportTitle(prev.reportType)
        ? defaultSocArtifactReportTitle(type)
        : prev.reportTitle,
    }));
    setAiGeneratedReport(null);
  };

  const copyReport = async () => {
    await navigator.clipboard.writeText(report);
    setCopied(true);
    setNotice('Markdown artifact copied. Paste it into a local file, email draft, ticket, or analyst handoff document.');
    window.setTimeout(() => setCopied(false), 1800);
  };

  const generateWithAi = async () => {
    if (!currentModel) {
      setNotice('Select a model in Models before generating a grounded report.');
      return;
    }
    if (!socKnowledgeCollectionId) {
      setNotice('Link and index a company knowledge collection in Grounded SOC Knowledge first.');
      return;
    }

    setAiBusy(true);
    setAiStatus('Preparing grounded report…');
    setNotice(null);
    setAiGeneratedReport(null);

    try {
      const result = await generateSocGroundedReport({
        collectionId: socKnowledgeCollectionId,
        workspaceInput,
        reportType: form.reportType,
        reportTitle: form.reportTitle || defaultSocArtifactReportTitle(form.reportType),
        templateMarkdown: templateReport,
        embeddingModelPath,
        retrievalMode,
        topK,
        currentModel,
        defaultParams,
        onStatus: setAiStatus,
        onChunk: setAiGeneratedReport,
      });
      setAiGeneratedReport(result.answer);
      void logAuditEvent({
        eventType: 'soc.report_generate',
        category: 'soc',
        summary: `Grounded report generated (${form.reportType})`,
        detail: `snippets=${result.retrieval.contextHits.length}; blocked=${result.skippedGeneration}`,
      });
      setNotice(
        result.skippedGeneration
          ? `AI report generated with limited folder evidence (${result.retrieval.contextHits.length} snippet(s) reviewed).`
          : `AI report generated with ${result.retrieval.contextHits.length} grounded company snippet(s).`,
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err || 'Report generation failed'));
    } finally {
      setAiBusy(false);
      setAiStatus(null);
    }
  };

  const sendToChat = (mode: 'compact' | 'full') => {
    const compactSummary = [
      `Report type: ${form.reportType}`,
      `Title: ${form.reportTitle || defaultSocArtifactReportTitle(form.reportType)}`,
      `Severity/verdict: ${form.severityVerdict || 'not specified'}`,
      `Scope/environment: ${form.scope || 'not specified'}`,
      `Auto-retrieved snippets: ${grounded.contextHits.length}`,
      `Selected knowledge references: ${selectedResources.length}`,
      `Selected retrieval snippets: ${selectedChunks.length}`,
      `Evidence summary: ${compactReportText(form.evidenceSummary || 'not provided', 700)}`,
      `Recommendations: ${compactReportText(form.recommendations || 'not provided', 700)}`,
      `Safety notes: ${compactReportText(form.safetyNotes || 'Human approval required before production response actions.', 500)}`,
      `Validator summary: ${compactReportText(form.validatorReport || 'not provided', 700)}`,
    ].join('\n');

    const prompt = mode === 'full'
      ? [
        SOC_SYSTEM_PROMPT,
        'Review this full SOC Markdown artifact. Improve clarity, identify missing evidence, and keep response actions behind human approval.',
        'Ground improvements in any company knowledge citations already present. Do not claim live FortiSIEM/FortiSOAR integration unless the report explicitly proves it.',
        '',
        report,
      ].join('\n')
      : [
        SOC_SYSTEM_PROMPT,
        'Review this short SOC summary. Improve clarity, identify missing evidence, and keep response actions behind human approval.',
        'Do not claim live FortiSIEM/FortiSOAR integration.',
        '',
        compactSummary,
      ].join('\n');

    setPendingChatPrompt(prompt, { soc: true, autoSend: true });
    setActiveView('chat');
    setSidebarOpen(false);
    setNotice(mode === 'full' ? 'Full Markdown artifact loaded into Chat for deeper local model review.' : 'Compact report summary loaded into Chat for faster review.');
  };

  const reset = () => {
    setForm(emptySocArtifactReportInput);
    setAiGeneratedReport(null);
    setNotice('SOC report fields reset.');
  };

  return (
    <section className="panel-shell p-4 sm:p-6 space-y-5">
      <div className="inline-flex items-center gap-2 rounded-full border border-indigo-200/80 dark:border-indigo-900/70 bg-indigo-50/85 dark:bg-indigo-950/25 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-indigo-700 dark:text-indigo-300">
        <FileText className="w-4 h-4" /> Reports
      </div>
      <h2 className="text-xl font-black tracking-tight text-surface-950 dark:text-white">SOC Reports</h2>

      {grounded.hasAutoRetrieval && (
        <SocRetrievedSources
          hits={grounded.contextHits}
          loading={grounded.loading}
          error={grounded.error}
          notice={grounded.notice}
          query={grounded.query}
          onRefresh={() => void grounded.refresh()}
          compact
        />
      )}

      <div className="grid xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] gap-5">
        <div className="space-y-4">
          <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4 space-y-4">
            <div className="flex items-center gap-2">
              <ListChecks className="w-5 h-5 text-indigo-500" />
              <h3 className="font-black text-surface-950 dark:text-white">Report Builder</h3>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              {fieldLabel('Report title',
                <input value={form.reportTitle} onChange={e => update('reportTitle', e.target.value)} className="input-field mt-1" placeholder="VPN brute-force triage report" />
              )}
              {fieldLabel('Report type',
                <select value={form.reportType} onChange={e => changeType(e.target.value as SocArtifactReportType)} className="input-field mt-1">
                  {SOC_ARTIFACT_REPORT_TYPES.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              )}
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              {fieldLabel('Severity / verdict',
                <input value={form.severityVerdict} onChange={e => update('severityVerdict', e.target.value)} className="input-field mt-1" placeholder="Needs more evidence / High / likely true positive..." />
              )}
              {fieldLabel('Scope / environment',
                <input value={form.scope} onChange={e => update('scope', e.target.value)} className="input-field mt-1" placeholder="FortiSIEM 7.x, VPN logs, lab tenant, exported alert..." />
              )}
            </div>

            {fieldLabel('Evidence summary',
              <textarea value={form.evidenceSummary} onChange={e => update('evidenceSummary', e.target.value)} rows={4} className="input-field mt-1" placeholder="Summarize the strongest evidence. One line per point works best." />
            )}

            {fieldLabel('Assumptions',
              <textarea value={form.assumptions} onChange={e => update('assumptions', e.target.value)} rows={3} className="input-field mt-1" placeholder="Example: No live FortiSIEM API connection; sample logs are exported; actions require human approval..." />
            )}

            {fieldLabel('Recommendations',
              <textarea value={form.recommendations} onChange={e => update('recommendations', e.target.value)} rows={4} className="input-field mt-1" placeholder="Recommended investigation, tuning, parser/playbook work, or next approval step." />
            )}

            {fieldLabel('Human approval / safety notes',
              <textarea value={form.safetyNotes} onChange={e => update('safetyNotes', e.target.value)} rows={3} className="input-field mt-1" placeholder="All production actions require analyst approval and rollback/verification plan." />
            )}

            {fieldLabel('Validator report text / engineering checks',
              <textarea value={form.validatorReport} onChange={e => update('validatorReport', e.target.value)} rows={5} className="input-field mt-1 font-mono text-xs" placeholder="Paste a compact validator summary or exported report excerpt here when you want it included in the artifact." />
            )}

            {fieldLabel('Analyst / company notes',
              <textarea value={form.analystNotes} onChange={e => update('analystNotes', e.target.value)} rows={4} className="input-field mt-1" placeholder="Handoff notes, version info, or constraints for your team." />
            )}

            <button
              type="button"
              onClick={() => void generateWithAi()}
              disabled={aiBusy}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              {aiBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {aiBusy ? (aiStatus || 'Generating…') : 'Generate Grounded Report with AI'}
            </button>
          </div>

          <div className="grid sm:grid-cols-3 gap-3">
            <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-4">
              <div className="flex items-center gap-2 text-surface-500 dark:text-surface-400">
                <Layers className="w-4 h-4" />
                <span className="text-xs font-bold uppercase tracking-[0.14em]">Auto snippets</span>
              </div>
              <p className="mt-2 text-2xl font-black text-surface-950 dark:text-white">{grounded.contextHits.length}</p>
              <p className="text-xs text-surface-500 dark:text-surface-400">from company index</p>
            </div>
            <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-4">
              <div className="flex items-center gap-2 text-surface-500 dark:text-surface-400">
                <ClipboardCopy className="w-4 h-4" />
                <span className="text-xs font-bold uppercase tracking-[0.14em]">Manual</span>
              </div>
              <p className="mt-2 text-2xl font-black text-surface-950 dark:text-white">{selectedChunks.length}</p>
              <p className="text-xs text-surface-500 dark:text-surface-400">selected snippets</p>
            </div>
            <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-4">
              <div className="flex items-center gap-2 text-surface-500 dark:text-surface-400">
                <ShieldCheck className="w-4 h-4" />
                <span className="text-xs font-bold uppercase tracking-[0.14em]">Safety</span>
              </div>
              <p className="mt-2 text-sm font-black text-surface-950 dark:text-white">Human-approved</p>
              <p className="text-xs text-surface-500 dark:text-surface-400">draft workflow</p>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 overflow-hidden flex flex-col min-h-[44rem]">
          <div className="px-4 py-3 border-b border-white/70 dark:border-surface-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Markdown Preview</p>
              <h3 className="font-black text-surface-950 dark:text-white">
                {aiGeneratedReport ? 'AI Grounded Report' : 'Template Report'}
              </h3>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <button type="button" onClick={copyReport} className="btn-secondary flex items-center justify-center gap-2 text-sm">
                {copied ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied' : 'Copy Report'}
              </button>
              <SocExportButton
                label="Export Report"
                defaultFileName={form.reportTitle.trim() || defaultSocArtifactReportTitle(form.reportType)}
                contents={report}
                kind="md"
                className="btn-secondary text-sm"
                onStatus={(message) => setNotice(message)}
              />
              <button type="button" onClick={() => sendToChat('compact')} className="btn-secondary flex items-center justify-center gap-2 text-sm">
                <Send className="w-4 h-4" /> Send Compact to Chat
              </button>
              <button type="button" onClick={() => sendToChat('full')} className="btn-primary flex items-center justify-center gap-2 text-sm">
                <Send className="w-4 h-4" /> Send Full Report to Chat
              </button>
            </div>
          </div>

          <textarea
            value={report}
            readOnly
            className="flex-1 w-full min-h-[38rem] bg-transparent p-4 text-xs leading-5 font-mono text-surface-700 dark:text-surface-200 resize-none focus:outline-none"
          />

          <div className="border-t border-white/70 dark:border-surface-800 p-4 space-y-3">
            {notice && (
              <div className="rounded-2xl border border-sky-200/80 dark:border-sky-900/70 bg-sky-50/90 dark:bg-sky-950/25 px-4 py-3 text-sm text-sky-700 dark:text-sky-300">
                {notice}
              </div>
            )}
            <div className="flex flex-col sm:flex-row gap-2">
              <button type="button" onClick={reset} className="btn-secondary flex-1 flex items-center justify-center gap-2">
                <FileText className="w-4 h-4" /> Reset Fields
              </button>
              {aiGeneratedReport && (
                <button type="button" onClick={() => setAiGeneratedReport(null)} className="btn-secondary flex-1">
                  Show Template Only
                </button>
              )}
              <SocExportButton
                label="Save Markdown File"
                defaultFileName={form.reportTitle.trim() || defaultSocArtifactReportTitle(form.reportType)}
                contents={report}
                kind="md"
                className="btn-secondary flex-1"
                onStatus={(message) => setNotice(message)}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
