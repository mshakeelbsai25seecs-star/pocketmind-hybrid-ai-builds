export type SocCaseStatus =
  | 'new'
  | 'investigating'
  | 'needs_human'
  | 'pending_approval'
  | 'closed';

export type SocDisposition =
  | 'undetermined'
  | 'benign'
  | 'suspicious'
  | 'malicious'
  | 'needs_evidence';

export type SocSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'unknown';

export type SocConfidence = 'low' | 'medium' | 'high' | 'unknown';

export type SocCaseSourceKind = 'manual' | 'import' | 'connector';

export interface SocEntityRefs {
  sourceIp: string;
  destinationIp: string;
  username: string;
  asset: string;
  hostnames: string[];
  urls: string[];
  hashes: string[];
  extra: Record<string, string>;
}

export interface SocEvidenceStep {
  id: string;
  at: number;
  source: string;
  action: string;
  detail: string;
  hypothesis?: string;
  artifactPath?: string;
  ok: boolean;
}

export interface SocVerdict {
  disposition: SocDisposition;
  confidence: SocConfidence;
  summary: string;
  reasoning: string;
  evidenceFound: string[];
  missingEvidence: string[];
  recommendedActions: string[];
  mitreTechniques: string[];
  interviewQuestions: string[];
  aiDisposition?: SocDisposition;
  aiConfidence?: SocConfidence;
  generatedAt?: number;
  modelId?: string;
  rawModelText?: string;
}

export interface SocOverrideRecord {
  at: number;
  by: string;
  field: 'disposition' | 'confidence' | 'status';
  from: string;
  to: string;
  note: string;
}

export interface SocCaseSource {
  kind: SocCaseSourceKind;
  connectorId?: string;
  importBatchId?: string;
  externalId?: string;
}

export interface SocCase {
  schemaVersion: 1;
  id: string;
  title: string;
  status: SocCaseStatus;
  severity: SocSeverity;
  disposition: SocDisposition;
  source: SocCaseSource;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  assignee: string;
  summary: string;
  rawEvidence: string;
  entities: SocEntityRefs;
  tags: string[];
  notes: string;
  evidenceChain: SocEvidenceStep[];
  verdict: SocVerdict | null;
  overrides: SocOverrideRecord[];
  approvedAt?: number;
  approvedBy?: string;
  engineering: {
    draftRule?: string;
    draftParser?: string;
    draftPlaybook?: string;
    lastWorkspaceAction?: string;
  };
  timings: {
    firstInvestigatedAt?: number;
    firstVerdictAt?: number;
  };
  importPayloadPath?: string;
}

export interface SocCaseIndexEntry {
  id: string;
  title: string;
  status: string;
  severity: string;
  disposition: string;
  source_kind: string;
  created_at: number;
  updated_at: number;
  closed_at?: number | null;
  assignee: string;
  external_id?: string | null;
}

export interface SocMemoryEntry {
  schemaVersion: 1;
  id: string;
  entityType: 'ip' | 'user' | 'host' | 'domain' | 'process' | 'other';
  key: string;
  note: string;
  classification: 'benign_expected' | 'suspicious_watch' | 'malicious_known' | 'context';
  active: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  createdFromCaseId?: string;
}

export interface SocImportBatch {
  id: string;
  at: number;
  files: string[];
  createdCaseIds: string[];
  errors: { file: string; row?: number; message: string }[];
}

export interface SocMetricsSummary {
  total_cases: number;
  open_cases: number;
  closed_cases: number;
  with_verdict: number;
  disposition_mix: Record<string, number>;
  source_mix: Record<string, number>;
  median_time_to_verdict_ms?: number | null;
  p90_time_to_verdict_ms?: number | null;
  median_time_to_close_ms?: number | null;
  p90_time_to_close_ms?: number | null;
  override_rate?: number | null;
  override_count: number;
  investigated_coverage: number;
  computed_at: number;
}

export interface SocConnectorDescriptor {
  id: string;
  label: string;
  modes: Array<'offline_import' | 'live_api'>;
  capabilities: Array<'ingest' | 'query' | 'enrich' | 'respond'>;
  status: 'available' | 'not_configured' | 'disabled_in_build';
  configSchemaVersion: 1;
}

export interface ParsedAlert {
  externalId?: string;
  title: string;
  summary: string;
  severity: SocSeverity;
  rawEvidence: string;
  entities: Partial<SocEntityRefs>;
  notes?: string;
  tags?: string[];
  sourceLabel: string;
  originalPayload?: string;
}
