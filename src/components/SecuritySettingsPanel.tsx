import { useEffect, useState } from 'react';
import { ShieldCheck, Save, Loader2 } from 'lucide-react';
import { useAppStore } from '../store';
import {
  loadProductConfig,
  saveProductConfig,
  type ProductConfig,
  DEFAULT_PRODUCT_CONFIG,
} from '../productConfig';

export default function SecuritySettingsPanel() {
  const { productConfig, setProductConfig } = useAppStore();
  const [form, setForm] = useState<ProductConfig>(productConfig || DEFAULT_PRODUCT_CONFIG);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (productConfig) setForm(productConfig);
  }, [productConfig]);

  const update = <K extends keyof ProductConfig>(key: K, value: ProductConfig[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const reload = async () => {
    setBusy(true);
    setError(null);
    try {
      const config = await loadProductConfig();
      setForm(config);
      setProductConfig(config);
      setNotice('Settings reloaded.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveProductConfig(form);
      setForm(saved);
      setProductConfig(saved);
      setNotice('Security settings saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="glass-panel rounded-xl p-6 space-y-4">
        <h3 className="font-semibold flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-primary-500" />
          Security &amp; quality
        </h3>
        <p className="text-sm text-surface-600 dark:text-surface-300">
          Control when AI answers are allowed and whether actions are recorded in the audit log.
        </p>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.block_low_confidence_generation}
            onChange={e => update('block_low_confidence_generation', e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="block font-medium">Require strong document matches</span>
            <span className="text-xs text-surface-500">
              When enabled, the app will not generate an AI answer unless indexed company files match the question well enough.
            </span>
          </span>
        </label>

        <label className="block">
          <span className="block text-sm font-medium mb-2">Minimum match score (0–1)</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={form.min_confidence_score}
            onChange={e => update('min_confidence_score', Number(e.target.value) || 0.15)}
            className="input-field w-40"
          />
          <p className="mt-1 text-xs text-surface-500">Higher values demand stronger evidence from your indexed folder.</p>
        </label>

        <label className="block">
          <span className="block text-sm font-medium mb-2">Min source confidence for context (0–1)</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={form.min_source_confidence_for_context}
            onChange={e => update('min_source_confidence_for_context', Number(e.target.value) || 0.42)}
            className="input-field w-40"
          />
          <p className="mt-1 text-xs text-surface-500">Code entities and sources below this score are excluded from the LLM context block.</p>
        </label>

        <label className="block">
          <span className="block text-sm font-medium mb-2">Min source confidence for generation (0–1)</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={form.min_source_confidence_for_generation}
            onChange={e => update('min_source_confidence_for_generation', Number(e.target.value) || 0.28)}
            className="input-field w-40"
          />
          <p className="mt-1 text-xs text-surface-500">Knowledge Chat will not call the LLM unless at least one source meets this threshold.</p>
        </label>

        <label className="block">
          <span className="block text-sm font-medium mb-2">Knowledge Chat deployment profile</span>
          <select
            value={form.knowledge_chat_deployment_profile}
            onChange={e => update('knowledge_chat_deployment_profile', e.target.value as ProductConfig['knowledge_chat_deployment_profile'])}
            className="input-field w-full max-w-md"
          >
            <option value="demo">Demo (laptop) — reduced context window for local models</option>
            <option value="server">Server — full context for 70B+ offline deployment</option>
          </select>
          <p className="mt-1 text-xs text-surface-500">
            Server profile sends more retrieved sources and a larger context block to the model. Use demo while testing on a laptop.
          </p>
        </label>

        <label className="block">
          <span className="block text-sm font-medium mb-2">Knowledge Chat mode</span>
          <select
            value={form.knowledge_chat_mode}
            onChange={e => update('knowledge_chat_mode', e.target.value as ProductConfig['knowledge_chat_mode'])}
            className="input-field w-full max-w-md"
          >
            <option value="folder_qa">Folder Q&amp;A — cheatsheet-guided document answers</option>
            <option value="codebase_explorer">Codebase Explorer — repo map + symbol-first code retrieval</option>
          </select>
          <p className="mt-1 text-xs text-surface-500">
            Codebase Explorer injects a repo map and pins matching functions/classes for engineering questions. Both modes share the same local index.
          </p>
        </label>

        <div className="rounded-lg border border-surface-200 dark:border-surface-700 p-4 space-y-3">
          <p className="text-sm font-medium">Knowledge Chat indexing (rebuild index after changes)</p>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.enable_contextual_indexing}
              onChange={e => update('enable_contextual_indexing', e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block font-medium">Contextual chunk prefixes</span>
              <span className="text-xs text-surface-500">
                Prepends file/section context to chunk text before embedding and FTS for better retrieval.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.enable_semantic_chunking}
              onChange={e => update('enable_semantic_chunking', e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block font-medium">Semantic paragraph chunking</span>
              <span className="text-xs text-surface-500">
                Splits prose on paragraph boundaries instead of fixed token windows when possible.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.enable_exact_dense_search}
              onChange={e => update('enable_exact_dense_search', e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block font-medium">Exact dense prefetch</span>
              <span className="text-xs text-surface-500">
                Linear cosine scan over all embeddings (slower on large folders, best recall). Enabled automatically on Server profile.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.enable_llm_contextual_summaries}
              onChange={e => update('enable_llm_contextual_summaries', e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block font-medium">Contextual chunk summaries</span>
              <span className="text-xs text-surface-500">
                Adds a one-line topic summary to each chunk prefix at index time (deterministic today; LLM hook for 3B+ models later). Rebuild index after enabling.
              </span>
            </span>
          </label>
        </div>

        <label className="block">
          <span className="block text-sm font-medium mb-2">Knowledge Chat answer style</span>
          <select
            value={form.knowledge_chat_evidence_mode}
            onChange={e => update('knowledge_chat_evidence_mode', e.target.value as ProductConfig['knowledge_chat_evidence_mode'])}
            className="input-field w-full max-w-md"
          >
            <option value="concise">Concise — synthesized answer only (evidence fallback when blocked)</option>
            <option value="evidence_explanation">Evidence + explanation — always show source excerpt and what it means</option>
          </select>
          <p className="mt-1 text-xs text-surface-500">
            Evidence mode shows the indexed text and a plain-language summary so you can verify answers.
          </p>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.audit_log_enabled}
            onChange={e => update('audit_log_enabled', e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="block font-medium">Record audit log</span>
            <span className="text-xs text-surface-500">
              Logs exports, indexing, triage, reports, and setting changes locally. View under Settings → Audit.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.allow_intent_short_circuit}
            onChange={e => update('allow_intent_short_circuit', e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="block font-medium">Allow intent cache short-circuit</span>
            <span className="text-xs text-surface-500">
              When enabled, very high-confidence FAQ-style intent matches can answer without running full document retrieval. Off by default for safer grounding.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.enable_llm_query_expand}
            onChange={e => update('enable_llm_query_expand', e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="block font-medium">LLM expansion for vague Knowledge Chat queries</span>
            <span className="text-xs text-surface-500">
              Uses the active local model to rewrite shorthand questions before retrieval when rule-based expansion is not enough.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.folder_agnostic_mode}
            onChange={e => update('folder_agnostic_mode', e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="block font-medium">Folder-agnostic Knowledge Chat mode</span>
            <span className="text-xs text-surface-500">
              Disables SOC-specific retrieval filters, intent shortcuts, and defaults eval to generic folder checks.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.enable_hyde}
            onChange={e => update('enable_hyde', e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="block font-medium">HyDE dense retrieval expansion</span>
            <span className="text-xs text-surface-500">
              Embeds a hypothetical document passage for dense search. Can help vague questions; may add latency.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap gap-2 pt-2">
          <button type="button" onClick={() => void save()} disabled={busy} className="btn-primary flex items-center gap-2 disabled:opacity-60">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save
          </button>
          <button type="button" onClick={() => void reload()} disabled={busy} className="btn-secondary">
            Reload
          </button>
        </div>

        {notice && <p className="text-sm text-emerald-600 dark:text-emerald-300">{notice}</p>}
        {error && <p className="text-sm text-red-600 dark:text-red-300">{error}</p>}
      </div>
    </div>
  );
}
