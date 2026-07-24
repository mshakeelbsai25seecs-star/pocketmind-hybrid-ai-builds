import { useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ClipboardCopy, Code2, Copy, FileJson, FileText,
  Microscope, Play, Regex, SearchCheck, Send, XCircle
} from 'lucide-react';
import { useAppStore } from '../store';
import { SOC_SYSTEM_PROMPT } from '../socChatHandoff';
import SocExportButton from './SocExportButton';
import {
  buildSocValidatorChatPrompt,
  formatSocValidatorReport,
  runSocValidators,
  type SocValidatorFinding,
  type SocValidatorInput,
  type SocValidatorResult,
  type SocValidatorStatus,
} from '../socValidators';

const emptyInput: SocValidatorInput = {
  artifactText: '',
  sampleLogs: '',
  regexText: '',
  notes: '',
};

function statusClasses(status: SocValidatorStatus): string {
  switch (status) {
    case 'pass':
      return 'border-emerald-200 dark:border-emerald-900/70 bg-emerald-50/85 dark:bg-emerald-950/25 text-emerald-800 dark:text-emerald-300';
    case 'warning':
      return 'border-amber-200 dark:border-amber-900/70 bg-amber-50/85 dark:bg-amber-950/25 text-amber-800 dark:text-amber-300';
    case 'fail':
      return 'border-red-200 dark:border-red-900/70 bg-red-50/85 dark:bg-red-950/25 text-red-800 dark:text-red-300';
    case 'info':
    default:
      return 'border-primary-200 dark:border-primary-900/70 bg-primary-50/85 dark:bg-primary-950/25 text-primary-800 dark:text-primary-300';
  }
}

function StatusIcon({ status }: { status: SocValidatorStatus }) {
  if (status === 'pass') return <CheckCircle2 className="w-4 h-4" />;
  if (status === 'fail') return <XCircle className="w-4 h-4" />;
  if (status === 'warning') return <AlertTriangle className="w-4 h-4" />;
  return <SearchCheck className="w-4 h-4" />;
}

function countByStatus(findings: SocValidatorFinding[], status: SocValidatorStatus): number {
  return findings.filter(finding => finding.status === status).length;
}

function shortList(values: string[], empty = 'none'): string {
  if (!values.length) return empty;
  return values.slice(0, 12).join(', ') + (values.length > 12 ? ` +${values.length - 12} more` : '');
}

export default function SocValidators() {
  const [input, setInput] = useState<SocValidatorInput>(emptyInput);
  const [result, setResult] = useState<SocValidatorResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { setPendingChatPrompt, setActiveView } = useAppStore();

  const report = useMemo(() => result ? formatSocValidatorReport(result, input) : '', [result, input]);

  const updateInput = <K extends keyof SocValidatorInput>(key: K, value: SocValidatorInput[K]) => {
    setInput(prev => ({ ...prev, [key]: value }));
    setNotice(null);
  };

  const runChecks = () => {
    const nextResult = runSocValidators(input);
    setResult(nextResult);
    const failCount = countByStatus(nextResult.findings, 'fail');
    const warningCount = countByStatus(nextResult.findings, 'warning');
    setNotice(`Validator run completed locally: ${failCount} fail, ${warningCount} warning. No internet or live Fortinet connection was used.`);
  };

  const copyReport = async () => {
    if (!result) {
      setNotice('Run validators first, then copy the report.');
      return;
    }
    await navigator.clipboard.writeText(report);
    setCopied(true);
    setNotice('Validator report copied. Use Compact Chat for speed or Full Report to Chat for deeper local model review.');
    window.setTimeout(() => setCopied(false), 1600);
  };

  const sendToChat = (mode: 'compact' | 'full') => {
    if (!result) {
      setNotice('Run validators first, then send the validator output to Chat.');
      return;
    }
    const prompt = mode === 'full'
      ? [
        SOC_SYSTEM_PROMPT,
        'Review this full deterministic validator report. Keep findings source-grounded, identify missing evidence, and keep response actions behind human approval.',
        '',
        report,
      ].join('\n')
      : buildSocValidatorChatPrompt(result, input);
    setPendingChatPrompt(prompt, { soc: true, autoSend: true });
    setActiveView('chat');
    setNotice(mode === 'full' ? 'Full validator report loaded into Chat for deeper local model review.' : 'Compact validator summary loaded into Chat for faster review.');
  };

  const clear = () => {
    setInput(emptyInput);
    setResult(null);
    setNotice('Validator inputs cleared.');
  };

  const passCount = result ? countByStatus(result.findings, 'pass') : 0;
  const warningCount = result ? countByStatus(result.findings, 'warning') : 0;
  const failCount = result ? countByStatus(result.findings, 'fail') : 0;
  const infoCount = result ? countByStatus(result.findings, 'info') : 0;

  return (
    <section className="panel-shell p-4 sm:p-6 space-y-6">
      <div className="inline-flex items-center gap-2 rounded-full border border-violet-200/80 dark:border-violet-800/70 bg-violet-50/85 dark:bg-violet-950/30 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-violet-700 dark:text-violet-300">
        <Microscope className="w-4 h-4" /> Validators
      </div>
      <h2 className="text-xl font-black text-surface-950 dark:text-white">SOC Validators</h2>

      <div className="grid md:grid-cols-4 gap-3">
        <div className="rounded-2xl border border-emerald-200/70 dark:border-emerald-900/60 bg-emerald-50/75 dark:bg-emerald-950/20 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300">Pass</p>
          <p className="mt-1 text-2xl font-black text-surface-950 dark:text-white">{passCount}</p>
        </div>
        <div className="rounded-2xl border border-amber-200/70 dark:border-amber-900/60 bg-amber-50/75 dark:bg-amber-950/20 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-700 dark:text-amber-300">Warning</p>
          <p className="mt-1 text-2xl font-black text-surface-950 dark:text-white">{warningCount}</p>
        </div>
        <div className="rounded-2xl border border-red-200/70 dark:border-red-900/60 bg-red-50/75 dark:bg-red-950/20 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-700 dark:text-red-300">Fail</p>
          <p className="mt-1 text-2xl font-black text-surface-950 dark:text-white">{failCount}</p>
        </div>
        <div className="rounded-2xl border border-primary-200/70 dark:border-primary-900/60 bg-primary-50/75 dark:bg-primary-950/20 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-primary-700 dark:text-primary-300">Info</p>
          <p className="mt-1 text-2xl font-black text-surface-950 dark:text-white">{infoCount}</p>
        </div>
      </div>

      <div className="grid xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-6">
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Validator Inputs</p>
              <h3 className="font-black text-surface-950 dark:text-white">Artifact + sample evidence</h3>
            </div>
            <Code2 className="w-5 h-5 text-surface-400" />
          </div>

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Parser XML / rule draft / playbook JSON-YAML</span>
            <textarea
              value={input.artifactText}
              onChange={e => updateInput('artifactText', e.target.value)}
              rows={9}
              className="input-field mt-1 font-mono text-xs"
              placeholder="Paste FortiSIEM parser XML, FortiSIEM rule notes, FortiSOAR playbook JSON/YAML, or connector workflow draft..."
            />
          </label>

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Sample logs</span>
            <textarea
              value={input.sampleLogs}
              onChange={e => updateInput('sampleLogs', e.target.value)}
              rows={6}
              className="input-field mt-1 font-mono text-xs"
              placeholder="Paste matching and non-matching sample logs for parser/rule regex checks..."
            />
          </label>

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Regex to test</span>
            <div className="mt-1 flex items-center gap-2">
              <Regex className="w-5 h-5 text-surface-400 shrink-0" />
              <input
                value={input.regexText}
                onChange={e => updateInput('regexText', e.target.value)}
                className="input-field font-mono text-xs"
                placeholder="/failed login.*user=(?<user>\\S+)/i or plain regex"
              />
            </div>
          </label>

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Analyst notes / review objective</span>
            <textarea
              value={input.notes}
              onChange={e => updateInput('notes', e.target.value)}
              rows={4}
              className="input-field mt-1"
              placeholder="What should the validator focus on? Example: parser import readiness, phishing playbook safety, VPN brute-force detection tuning..."
            />
          </label>

          {notice && (
            <div className="rounded-2xl border border-primary-200/80 dark:border-primary-900/70 bg-primary-50/90 dark:bg-primary-950/25 px-4 py-3 text-sm text-primary-700 dark:text-primary-300">
              {notice}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-2">
            <button type="button" onClick={runChecks} className="btn-primary flex-1 flex items-center justify-center gap-2">
              <Play className="w-4 h-4" /> Run Checks
            </button>
            <button type="button" onClick={clear} className="btn-secondary flex items-center justify-center gap-2">
              <FileText className="w-4 h-4" /> Clear
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4 space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Validator Results</p>
              <h3 className="font-black text-surface-950 dark:text-white">Pass / warning / fail findings</h3>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <button type="button" onClick={copyReport} className="btn-secondary flex items-center justify-center gap-2 text-sm">
                {copied ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied' : 'Copy Report'}
              </button>
              <SocExportButton
                label="Export Report"
                defaultFileName="nexus-soc-validator-report.md"
                contents={report}
                kind="md"
                className="btn-secondary text-sm"
                disabled={!result}
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

          {!result ? (
            <div className="rounded-2xl border border-dashed border-surface-300 dark:border-surface-700 p-6 text-center text-sm text-surface-500 dark:text-surface-400">
              Run local checks to generate deterministic findings, IOC candidates, regex matches, and a copyable validator report.
            </div>
          ) : (
            <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.42fr)] gap-4">
              <div className="space-y-3 max-h-[42rem] overflow-y-auto pr-1">
                {result.findings.map((finding, index) => (
                  <article key={`${finding.id}-${index}`} className={`rounded-2xl border p-4 ${statusClasses(finding.status)}`}>
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 shrink-0"><StatusIcon status={finding.status} /></div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[11px] font-black uppercase tracking-[0.16em]">{finding.status}</span>
                          <h4 className="font-black text-surface-950 dark:text-white">{finding.title}</h4>
                        </div>
                        <p className="mt-1 text-sm leading-6">{finding.message}</p>
                        {finding.detail && (
                          <pre className="mt-3 whitespace-pre-wrap rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-950/55 p-3 text-xs leading-5 text-surface-700 dark:text-surface-200 overflow-x-auto">{finding.detail}</pre>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
              </div>

              <aside className="space-y-4">
                <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-4">
                  <div className="flex items-center gap-2">
                    <SearchCheck className="w-4 h-4 text-surface-400" />
                    <h4 className="font-black text-surface-950 dark:text-white">IOC Candidates</h4>
                  </div>
                  <div className="mt-3 space-y-2 text-xs leading-5 text-surface-600 dark:text-surface-300 break-words">
                    <p><strong>IPs:</strong> {shortList(result.iocs.ips)}</p>
                    <p><strong>Domains:</strong> {shortList(result.iocs.domains)}</p>
                    <p><strong>URLs:</strong> {shortList(result.iocs.urls)}</p>
                    <p><strong>Hashes:</strong> {shortList(result.iocs.hashes)}</p>
                    <p><strong>Emails:</strong> {shortList(result.iocs.emails)}</p>
                  </div>
                </div>

                <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-4">
                  <div className="flex items-center gap-2">
                    <FileJson className="w-4 h-4 text-surface-400" />
                    <h4 className="font-black text-surface-950 dark:text-white">Regex Matches</h4>
                  </div>
                  <div className="mt-3 max-h-64 overflow-y-auto rounded-xl border border-white/70 dark:border-surface-800 bg-surface-50/80 dark:bg-surface-950/55 p-3">
                    {result.regexMatches.length ? (
                      <pre className="whitespace-pre-wrap text-xs leading-5 text-surface-700 dark:text-surface-200">{result.regexMatches.slice(0, 15).join('\n')}</pre>
                    ) : (
                      <p className="text-xs text-surface-500 dark:text-surface-400">No regex matches yet.</p>
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-4">
                  <div className="flex items-center gap-2">
                    <ClipboardCopy className="w-4 h-4 text-surface-400" />
                    <h4 className="font-black text-surface-950 dark:text-white">Report Preview</h4>
                  </div>
                  <textarea value={report} readOnly rows={10} className="mt-3 w-full rounded-xl border border-white/70 dark:border-surface-800 bg-surface-50/80 dark:bg-surface-950/55 p-3 text-xs font-mono leading-5 text-surface-700 dark:text-surface-200 resize-none focus:outline-none" />
                </div>
              </aside>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
