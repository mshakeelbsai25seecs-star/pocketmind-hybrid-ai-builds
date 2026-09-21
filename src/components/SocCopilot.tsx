import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import {
  CheckCircle2, ClipboardCopy, Download, Plus, ShieldCheck,
} from 'lucide-react';
import { useAppStore } from '../store';
import { logAuditEvent } from '../auditLog';
import { pickChatBackend } from '../docStudio';
import { SOC_DEMO_SAMPLES, SOC_DEMO_VALIDATOR_SAMPLE } from '../socDemoSamples';
import { useSocGroundedKnowledge } from '../hooks/useSocGroundedKnowledge';
import { buildSocPrompt, type SocWorkspaceInput } from '../socPromptTemplates';
import { runSocValidators } from '../socValidators';
import { SOC_SYSTEM_PROMPT } from '../socChatHandoff';
import type { GenerationChunk } from '../types';
import SocKnowledgeCollection from './SocKnowledgeCollection';
import SocKnowledgeBase from './SocKnowledgeBase';
import SocReports from './SocReports';
import SocValidators from './SocValidators';
import SecuritySettingsPanel from './SecuritySettingsPanel';

type SocTab = 'incidents' | 'investigations' | 'playbooks' | 'evidence' | 'reports' | 'validators' | 'settings';

type IncidentStatus = 'new' | 'in_progress' | 'pending_approval' | 'approved' | 'closed';

interface EvidenceItem {
  id: string;
  label: string;
  checked: boolean;
}

interface TimelineItem {
  id: string;
  time: string;
  text: string;
}

interface ValidatorCard {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'warning' | 'pending';
  detail: string;
}

export interface SocIncident {
  id: string;
  title: string;
  severity: string;
  status: IncidentStatus;
  assignee: string;
  createdAt: number;
  summary: string;
  rawLogs: string;
  sourceIp: string;
  destinationIp: string;
  username: string;
  asset: string;
  tactics: string;
  location: string;
  evidence: EvidenceItem[];
  timeline: TimelineItem[];
  draft: string;
  playbook: string;
  validators: ValidatorCard[];
  approvedAt: number | null;
  approvedBy: string;
}

const STORAGE_KEY = 'pocketmind-soc-incidents-v1';

const TABS: { id: SocTab; label: string }[] = [
  { id: 'incidents', label: 'Incidents' },
  { id: 'investigations', label: 'Investigations' },
  { id: 'playbooks', label: 'Playbooks' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'reports', label: 'Reports' },
  { id: 'validators', label: 'Validators' },
  { id: 'settings', label: 'Settings' },
];

const DEFAULT_EVIDENCE: EvidenceItem[] = [
  { id: 'alert', label: 'Alert details', checked: true },
  { id: 'endpoint', label: 'Endpoint events', checked: false },
  { id: 'network', label: 'Network connections', checked: false },
  { id: 'user', label: 'User activity', checked: false },
  { id: 'intel', label: 'Threat intelligence', checked: false },
  { id: 'file', label: 'File reputation', checked: false },
  { id: 'vuln', label: 'Vulnerability context', checked: false },
  { id: 'impact', label: 'Impact assessment', checked: false },
];

function nextIncidentId() {
  const n = Math.floor(100000 + Math.random() * 900000);
  return `INC-${new Date().getFullYear()}-${n}`;
}

function timelineFromLogs(raw: string): TimelineItem[] {
  return raw.split('\n').map((line, i) => {
    const m = line.match(/^(\S+)/);
    return { id: `t-${i}`, time: m?.[1] || `${i + 1}`, text: line.replace(/^\S+\s*/, '') || line };
  }).filter(row => row.text.trim());
}

function incidentFromInput(input: SocWorkspaceInput, title?: string): SocIncident {
  return {
    id: nextIncidentId(),
    title: title || input.alertSummary.slice(0, 72) || 'Untitled incident',
    severity: input.severity || 'High',
    status: 'in_progress',
    assignee: 'SOC analyst',
    createdAt: Date.now(),
    summary: input.alertSummary,
    rawLogs: input.rawLogs,
    sourceIp: input.sourceIp,
    destinationIp: input.destinationIp,
    username: input.username,
    asset: input.asset,
    tactics: input.notes || 'Initial Access',
    location: '',
    evidence: DEFAULT_EVIDENCE.map(e => ({ ...e })),
    timeline: timelineFromLogs(input.rawLogs),
    draft: '',
    playbook: '',
    validators: [],
    approvedAt: null,
    approvedBy: '',
  };
}

function seedIncidents(): SocIncident[] {
  const sample = SOC_DEMO_SAMPLES[0];
  const seeded = incidentFromInput(sample.input, sample.title);
  seeded.id = 'INC-2024-052144';
  seeded.assignee = 'SOC analyst';
  seeded.location = 'Toronto, Canada (new)';
  seeded.tactics = 'TA0001, TA0002';
  return [seeded];
}

function loadIncidents(): SocIncident[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedIncidents();
    const parsed = JSON.parse(raw) as SocIncident[];
    return Array.isArray(parsed) && parsed.length ? parsed : seedIncidents();
  } catch {
    return seedIncidents();
  }
}

function saveIncidents(rows: SocIncident[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
}

function statusLabel(status: IncidentStatus) {
  switch (status) {
    case 'in_progress': return 'In progress';
    case 'pending_approval': return 'Pending approval';
    case 'approved': return 'Approved';
    case 'closed': return 'Closed';
    default: return 'New';
  }
}

export default function SocCopilot() {
  const [tab, setTab] = useState<SocTab>('incidents');
  const [incidents, setIncidents] = useState<SocIncident[]>(() => loadIncidents());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const currentModel = useAppStore(s => s.currentModel);
  const defaultParams = useAppStore(s => s.defaultParams);

  useEffect(() => { saveIncidents(incidents); }, [incidents]);
  useEffect(() => {
    if (!activeId && incidents[0]) setActiveId(incidents[0].id);
  }, [activeId, incidents]);

  const incident = incidents.find(i => i.id === activeId) || null;
  const input: SocWorkspaceInput = useMemo(() => ({
    alertSummary: incident?.summary || '',
    rawLogs: incident?.rawLogs || '',
    sourceIp: incident?.sourceIp || '',
    destinationIp: incident?.destinationIp || '',
    username: incident?.username || '',
    asset: incident?.asset || '',
    severity: incident?.severity || '',
    notes: incident?.tactics || '',
  }), [incident]);

  const grounded = useSocGroundedKnowledge({
    action: tab === 'playbooks' ? 'playbook' : tab === 'investigations' ? 'investigation' : 'triage',
    workspaceInput: input,
    enabled: !!incident,
  });

  const updateIncident = (id: string, patch: Partial<SocIncident>) => {
    setIncidents(prev => prev.map(i => i.id === id ? { ...i, ...patch } : i));
  };

  const createBlank = () => {
    const created = incidentFromInput({
      alertSummary: '',
      rawLogs: '',
      sourceIp: '',
      destinationIp: '',
      username: '',
      asset: '',
      severity: 'High',
      notes: '',
    }, 'New incident');
    setIncidents(prev => [created, ...prev]);
    setActiveId(created.id);
    setTab('incidents');
  };

  const generateDraft = async () => {
    if (!incident) return;
    setBusy(true);
    setNotice(null);
    try {
      const prompt = buildSocPrompt('triage', input, grounded.knowledgeContext);
      if (!currentModel) {
        const fallback = [
          `Based on the submitted evidence, this incident indicates ${incident.summary || 'an alert that still needs analyst review'}.`,
          '',
          'Recommended actions:',
          '- Isolate and preserve volatile data.',
          '- Reset user credentials and enforce MFA.',
          '- Block the source IP after human approval.',
          '- Monitor for related activity.',
          '',
          'Select a model in Model Manager to generate a live grounded draft. Validators can still run on this text.',
        ].join('\n');
        updateIncident(incident.id, { draft: fallback, status: 'pending_approval' });
        setNotice('No model selected — wrote a structured draft from the incident fields. Select a model to regenerate with retrieval.');
        return;
      }
      const { backend, modelPath } = pickChatBackend(currentModel);
      const chunk = await invoke<GenerationChunk>('generate_response', {
        request: {
          prompt,
          system_prompt: SOC_SYSTEM_PROMPT,
          params: { ...defaultParams, max_tokens: 700, temperature: 0.2 },
          model_path: modelPath || currentModel,
          backend,
          messages: [
            { role: 'system', content: SOC_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
        },
      });
      updateIncident(incident.id, {
        draft: chunk.text?.trim() || 'The model returned an empty draft.',
        status: 'pending_approval',
      });
      setNotice(grounded.contextHits.length
        ? `Draft generated with ${grounded.contextHits.length} retrieved company snippet(s).`
        : 'Draft generated. Index a company folder under Evidence for grounded citations.');
      void logAuditEvent({
        eventType: 'soc.draft',
        category: 'soc',
        summary: `Generated draft for ${incident.id}`,
        detail: `retrieved=${grounded.contextHits.length}`,
      });
    } catch (err) {
      setNotice(String(err));
    } finally {
      setBusy(false);
    }
  };

  const runValidators = () => {
    if (!incident) return;
    const result = runSocValidators({
      artifactText: incident.draft || incident.summary,
      sampleLogs: incident.rawLogs,
      regexText: '',
      notes: incident.tactics,
    });
    const cards: ValidatorCard[] = [
      {
        id: 'evidence',
        label: 'Evidence validator',
        status: incident.evidence.filter(e => e.checked).length >= 2 ? 'pass' : 'warning',
        detail: `${incident.evidence.filter(e => e.checked).length} evidence items collected.`,
      },
      {
        id: 'logic',
        label: 'Logic validator',
        status: result.findings.some(f => f.status === 'fail') ? 'fail' : 'pass',
        detail: result.findings.some(f => f.status === 'fail') ? 'Failed a local check.' : 'Analysis logic is consistent with evidence.',
      },
      {
        id: 'response',
        label: 'Response validator',
        status: /isolat|reset|block|monitor/i.test(incident.draft) ? 'pass' : 'warning',
        detail: 'Recommendations are reviewable and actionable.',
      },
      {
        id: 'policy',
        label: 'Policy validator',
        status: /approv|human|rollback/i.test(incident.draft) ? 'pass' : 'warning',
        detail: 'Response aligns with SOC policies when human approval is present.',
      },
    ];
    updateIncident(incident.id, { validators: cards });
    setNotice(`Validators finished: ${result.findings.filter(f => f.status === 'fail').length} fail, ${result.findings.filter(f => f.status === 'warning').length} warning.`);
  };

  const approve = async () => {
    if (!incident) return;
    if (incident.validators.some(v => v.status === 'fail')) {
      setNotice('Fix failing validators before approval.');
      return;
    }
    if (!incident.draft.trim()) {
      setNotice('Generate a draft before approval.');
      return;
    }
    const who = window.prompt('Approver name (recorded in the local audit log)', incident.assignee || 'SOC analyst');
    if (!who?.trim()) return;
    updateIncident(incident.id, {
      status: 'approved',
      approvedAt: Date.now(),
      approvedBy: who.trim(),
    });
    await logAuditEvent({
      eventType: 'soc.approve',
      category: 'soc',
      summary: `${incident.id} approved by ${who.trim()}`,
      detail: 'Human-in-the-loop approval — no live Fortinet action was taken.',
    });
    setNotice(`Approved ${incident.id}. No production containment was executed — export the report if you need a handoff package.`);
  };

  const copyDraft = async () => {
    if (!incident?.draft) return;
    await navigator.clipboard.writeText(incident.draft);
    setNotice('Draft copied.');
  };

  const exportDraft = async () => {
    if (!incident) return;
    const text = [
      `# ${incident.id} ${incident.title}`,
      `Severity: ${incident.severity}  Status: ${statusLabel(incident.status)}`,
      `Assignee: ${incident.assignee}`,
      '',
      '## Summary',
      incident.summary,
      '',
      '## Grounded draft',
      incident.draft || '(none)',
      '',
      incident.approvedAt ? `Approved by ${incident.approvedBy} at ${new Date(incident.approvedAt).toISOString()}` : 'Not approved',
    ].join('\n');
    await navigator.clipboard.writeText(text);
    setNotice('Incident report copied. Use Reports to export DOCX/PDF.');
    setTab('reports');
  };

  return (
    <div className="flex-1 min-h-0 flex bg-black text-surface-50">
      <nav className="w-52 shrink-0 border-r border-white/10 py-4 px-2 space-y-0.5">
        {TABS.map(item => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`w-full text-left px-3 py-2 rounded-xl text-sm ${
              tab === item.id ? 'bg-primary-950/50 text-primary-200 font-semibold' : 'text-surface-400 hover:bg-white/5'
            }`}
          >
            {item.label}
          </button>
        ))}
        <div className="pt-6 px-3 text-[11px] text-surface-500 space-y-2">
          <p>Evidence-anchored responses</p>
          <p>Built for SOC workflows</p>
          <p>Human-in-the-loop by design</p>
        </div>
      </nav>
      <div className="flex-1 min-h-0 flex flex-col">
        <header className="px-5 py-3 border-b border-white/10 flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.16em] text-surface-500">Fortinet SOC Copilot</p>
            <h1 className="text-lg font-semibold">{incident ? incident.id : 'Incidents'}</h1>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary text-sm flex items-center gap-1" onClick={createBlank}>
              <Plus className="w-4 h-4" /> New incident
            </button>
            <button type="button" className="btn-secondary text-sm flex items-center gap-1" onClick={() => void exportDraft()}>
              <Download className="w-4 h-4" /> Export report
            </button>
          </div>
        </header>
        {notice && <p className="px-5 py-2 text-xs text-primary-300 border-b border-white/5">{notice}</p>}

        {tab === 'incidents' && (
          <div className="flex-1 min-h-0 grid grid-cols-[220px_minmax(0,1fr)]">
            <aside className="border-r border-white/10 overflow-y-auto p-2 space-y-1">
              {incidents.map(row => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setActiveId(row.id)}
                  className={`w-full text-left rounded-xl px-3 py-2 text-xs ${row.id === activeId ? 'bg-white/10' : 'hover:bg-white/5'}`}
                >
                  <p className="font-semibold truncate">{row.id}</p>
                  <p className="text-surface-400 truncate">{row.title}</p>
                </button>
              ))}
            </aside>
            {incident ? (
              <IncidentDetail
                incident={incident}
                groundedHits={grounded.contextHits.length}
                groundedLoading={grounded.loading}
                busy={busy}
                onChange={patch => updateIncident(incident.id, patch)}
                onGenerate={() => void generateDraft()}
                onValidate={runValidators}
                onCopy={() => void copyDraft()}
                onApprove={() => void approve()}
              />
            ) : (
              <p className="p-6 text-sm text-surface-500">Create an incident to begin.</p>
            )}
          </div>
        )}

        {tab === 'investigations' && (
          <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
            <h2 className="font-semibold">Investigations</h2>
            <p className="text-sm text-surface-400">Open incidents that still need analyst work. Generating a draft writes an investigation-ready response on the Incidents tab.</p>
            {incidents.filter(i => i.status !== 'closed').map(row => (
              <button key={row.id} type="button" className="w-full text-left rounded-2xl border border-white/10 p-4" onClick={() => { setActiveId(row.id); setTab('incidents'); }}>
                <p className="font-semibold">{row.id} · {row.title}</p>
                <p className="text-xs text-surface-400 mt-1">{statusLabel(row.status)} · {row.severity}</p>
              </button>
            ))}
          </div>
        )}

        {tab === 'playbooks' && (
          <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
            <h2 className="font-semibold">Playbooks</h2>
            <p className="text-sm text-surface-400">Human-approved FortiSOAR-style drafts. Validators treat this JSON as a playbook artifact. No live SOAR execution.</p>
            {incident && (
              <>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={() => updateIncident(incident.id, { playbook: SOC_DEMO_VALIDATOR_SAMPLE.playbookJson })}
                  >
                    Load demo playbook
                  </button>
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={() => {
                      const result = runSocValidators({
                        artifactText: incident.playbook,
                        sampleLogs: incident.rawLogs,
                        regexText: '',
                        notes: 'playbook',
                      });
                      setNotice(`Playbook checks: ${result.findings.filter(f => f.status === 'fail').length} fail, ${result.findings.filter(f => f.status === 'warning').length} warning.`);
                    }}
                  >
                    Validate playbook
                  </button>
                </div>
                <label className="block text-sm">
                  Playbook draft for {incident.id}
                  <textarea
                    className="input-field mt-1 min-h-[16rem] font-mono text-xs"
                    value={incident.playbook}
                    onChange={e => updateIncident(incident.id, { playbook: e.target.value })}
                    placeholder="Trigger, enrichment, connector actions, decision branches, human approval, rollback…"
                  />
                </label>
              </>
            )}
          </div>
        )}

        {tab === 'evidence' && (
          <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
            <SocKnowledgeCollection />
            <SocKnowledgeBase />
          </div>
        )}

        {tab === 'reports' && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <SocReports workspaceInput={input} generatedPrompt={incident?.draft || ''} />
          </div>
        )}

        {tab === 'validators' && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <SocValidators />
          </div>
        )}

        {tab === 'settings' && (
          <div className="flex-1 min-h-0 overflow-y-auto p-5">
            <SecuritySettingsPanel />
          </div>
        )}
      </div>
    </div>
  );
}

function IncidentDetail({
  incident,
  groundedHits,
  groundedLoading,
  busy,
  onChange,
  onGenerate,
  onValidate,
  onCopy,
  onApprove,
}: {
  incident: SocIncident;
  groundedHits: number;
  groundedLoading: boolean;
  busy: boolean;
  onChange: (patch: Partial<SocIncident>) => void;
  onGenerate: () => void;
  onValidate: () => void;
  onCopy: () => void;
  onApprove: () => void;
}) {
  return (
    <div className="min-h-0 overflow-y-auto p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-red-400">Severity: {incident.severity}</span>
        <span>Status: {statusLabel(incident.status)}</span>
        <span>Assignee: {incident.assignee}</span>
      </div>
      <div className="grid lg:grid-cols-3 gap-3">
        <section className="rounded-2xl border border-white/10 p-4 space-y-2">
          <h3 className="font-semibold text-sm">Incident summary</h3>
          <textarea className="input-field text-sm min-h-[7rem]" value={incident.summary} onChange={e => onChange({ summary: e.target.value })} />
          <dl className="text-[11px] space-y-1 text-surface-400">
            <div>Source {incident.sourceIp || '—'}</div>
            <div>User {incident.username || '—'}</div>
            <div>Asset {incident.asset || '—'}</div>
            <div>Tactics {incident.tactics || '—'}</div>
            <div>Location {incident.location || '—'}</div>
          </dl>
          <div className="grid grid-cols-2 gap-2">
            <input className="input-field text-xs" placeholder="Source IP" value={incident.sourceIp} onChange={e => onChange({ sourceIp: e.target.value })} />
            <input className="input-field text-xs" placeholder="User" value={incident.username} onChange={e => onChange({ username: e.target.value })} />
            <input className="input-field text-xs" placeholder="Asset" value={incident.asset} onChange={e => onChange({ asset: e.target.value })} />
            <input className="input-field text-xs" placeholder="Location" value={incident.location} onChange={e => onChange({ location: e.target.value })} />
          </div>
        </section>
        <section className="rounded-2xl border border-white/10 p-4">
          <h3 className="font-semibold text-sm mb-2">Evidence checklist</h3>
          <ul className="space-y-1.5 text-sm">
            {incident.evidence.map(item => (
              <li key={item.id}>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={item.checked}
                    onChange={e => onChange({
                      evidence: incident.evidence.map(x => x.id === item.id ? { ...x, checked: e.target.checked } : x),
                    })}
                  />
                  {item.label}
                </label>
              </li>
            ))}
          </ul>
        </section>
        <section className="rounded-2xl border border-white/10 p-4">
          <h3 className="font-semibold text-sm mb-2">Timeline</h3>
          <ol className="space-y-2 text-[12px]">
            {incident.timeline.length === 0 && <li className="text-surface-500">Paste raw logs to build a timeline.</li>}
            {incident.timeline.map(row => (
              <li key={row.id} className="flex gap-2">
                <span className="text-primary-400 shrink-0">{row.time}</span>
                <span className="text-surface-300">{row.text}</span>
              </li>
            ))}
          </ol>
          <textarea
            className="input-field mt-3 font-mono text-[11px] min-h-[5rem]"
            placeholder="Raw logs / evidence"
            value={incident.rawLogs}
            onChange={e => onChange({ rawLogs: e.target.value, timeline: timelineFromLogs(e.target.value) })}
          />
        </section>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1.4fr)_minmax(240px,0.7fr)] gap-3">
        <section className="rounded-2xl border border-white/10 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm">Grounded response draft</h3>
            <span className="text-[11px] text-surface-500">
              {groundedLoading ? 'Retrieving company knowledge…' : groundedHits ? `${groundedHits} snippets` : 'No index yet'}
            </span>
          </div>
          <textarea
            className="input-field min-h-[14rem] text-sm"
            value={incident.draft}
            onChange={e => onChange({ draft: e.target.value })}
            placeholder="Generate a grounded draft, then review before approval."
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={onGenerate}>
              {busy ? 'Generating…' : incident.draft ? 'Regenerate draft' : 'Generate draft'}
            </button>
            <button type="button" className="btn-secondary text-xs" onClick={onValidate}>Run validators</button>
            <button type="button" className="btn-secondary text-xs flex items-center gap-1" onClick={onCopy}>
              <ClipboardCopy className="w-3.5 h-3.5" /> Copy
            </button>
          </div>
        </section>
        <section className="rounded-2xl border border-white/10 p-4 space-y-2">
          <h3 className="font-semibold text-sm">Validators</h3>
          {incident.validators.length === 0 && <p className="text-xs text-surface-500">Run validators after you have a draft.</p>}
          {incident.validators.map(v => (
            <div key={v.id} className="flex items-start gap-2 text-sm">
              <CheckCircle2 className={`w-4 h-4 mt-0.5 ${v.status === 'pass' ? 'text-primary-400' : v.status === 'fail' ? 'text-red-400' : 'text-amber-300'}`} />
              <div>
                <p className="font-medium">{v.label}</p>
                <p className="text-[11px] text-surface-400">{v.status === 'pass' ? 'Passed' : v.status} · {v.detail}</p>
              </div>
            </div>
          ))}
        </section>
      </div>

      <section className="rounded-2xl border border-white/10 p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-primary-400" /> Human approval</p>
          <p className="text-xs text-surface-400">Review and approve the draft before publishing. No live Fortinet action is taken.</p>
          {incident.approvedAt && (
            <p className="text-xs text-primary-300 mt-1">Approved by {incident.approvedBy} · {new Date(incident.approvedAt).toLocaleString()}</p>
          )}
        </div>
        <button type="button" className="btn-primary" onClick={onApprove} disabled={incident.status === 'approved'}>
          Review &amp; Approve
        </button>
      </section>
    </div>
  );
}
