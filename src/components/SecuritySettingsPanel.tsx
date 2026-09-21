import { useEffect, useState } from 'react';
import { ShieldCheck, Save, Loader2 } from 'lucide-react';
import { useAppStore } from '../store';
import {
  loadProductConfig,
  saveProductConfig,
  type ProductConfig,
  DEFAULT_PRODUCT_CONFIG,
} from '../productConfig';
import {
  DEFAULT_OCR_IMAGE_RAG_CONFIG,
  downloadUnlimitedOcrModel,
  loadOcrCapabilities,
  loadOcrImageRagConfig,
  probeUnlimitedOcr,
  saveOcrImageRagConfig,
  testImageRagConnection,
  type OcrCapabilities,
  type OcrImageRagConfig,
  type UnlimitedOcrProbe,
} from '../ocrImageRagConfig';

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
          <span className="block text-sm font-medium mb-2">How strong a source must be to include it</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={form.min_source_confidence_for_context}
            onChange={e => update('min_source_confidence_for_context', Number(e.target.value) || 0.42)}
            className="input-field w-40"
          />
          <p className="mt-1 text-xs text-surface-500">Weaker matches are left out of what the model can see.</p>
        </label>

        <label className="block">
          <span className="block text-sm font-medium mb-2">How strong a source must be before answering</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={form.min_source_confidence_for_generation}
            onChange={e => update('min_source_confidence_for_generation', Number(e.target.value) || 0.28)}
            className="input-field w-40"
          />
          <p className="mt-1 text-xs text-surface-500">If nothing meets this bar, you’ll get a “not enough evidence” reply instead of a guess.</p>
        </label>

        <label className="block">
          <span className="block text-sm font-medium mb-2">Hardware profile</span>
          <select
            value={form.knowledge_chat_deployment_profile}
            onChange={e => update('knowledge_chat_deployment_profile', e.target.value as ProductConfig['knowledge_chat_deployment_profile'])}
            className="input-field w-full max-w-md"
          >
            <option value="demo">Laptop — lighter, for everyday use</option>
            <option value="server">Workstation / server — uses more context for larger models</option>
          </select>
        </label>

        <label className="block">
          <span className="block text-sm font-medium mb-2">Fortinet Copilot retrieval style</span>
          <select
            value={form.knowledge_chat_mode}
            onChange={e => update('knowledge_chat_mode', e.target.value as ProductConfig['knowledge_chat_mode'])}
            className="input-field w-full max-w-md"
          >
            <option value="folder_qa">Documents — answers from your files</option>
            <option value="codebase_explorer">Code — focuses on functions and classes</option>
          </select>
        </label>

        <div className="rounded-lg border border-surface-200 dark:border-surface-700 p-4 space-y-3">
          <p className="text-sm font-medium">Indexing options (rebuild your folder index after changing these)</p>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.enable_contextual_indexing}
              onChange={e => update('enable_contextual_indexing', e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block font-medium">Add file/section labels to each piece of text</span>
              <span className="text-xs text-surface-500">Helps search understand where a passage came from.</span>
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
              <span className="block font-medium">Split documents on natural paragraphs</span>
              <span className="text-xs text-surface-500">Keeps related sentences together when possible.</span>
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
              <span className="block font-medium">Thorough meaning search (slower on huge folders)</span>
              <span className="text-xs text-surface-500">Checks more candidates for better recall. On by default for the workstation profile.</span>
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
              <span className="block font-medium">Add short topic lines while indexing</span>
              <span className="text-xs text-surface-500">Can improve search; rebuild the index after turning this on.</span>
            </span>
          </label>
        </div>

        <label className="block">
          <span className="block text-sm font-medium mb-2">Answer style</span>
          <select
            value={form.knowledge_chat_evidence_mode}
            onChange={e => update('knowledge_chat_evidence_mode', e.target.value as ProductConfig['knowledge_chat_evidence_mode'])}
            className="input-field w-full max-w-md"
          >
            <option value="concise">Short answer</option>
            <option value="evidence_explanation">Answer plus quoted source text</option>
          </select>
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
            <span className="block font-medium">Instant answers for known FAQ matches</span>
            <span className="text-xs text-surface-500">
              Off by default. When on, very clear FAQ matches can answer without a full folder search.
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
            <span className="block font-medium">Clarify short questions before searching</span>
            <span className="text-xs text-surface-500">
              Uses your local chat model to expand vague questions into clearer search wording.
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
            <span className="block font-medium">Generic folder mode (not SOC-tuned)</span>
            <span className="text-xs text-surface-500">
              Use this for ordinary company folders instead of security-operations packs.
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
            <span className="block font-medium">Extra help for vague questions</span>
            <span className="text-xs text-surface-500">
              Searches as if a short matching document existed. Can help; may be a bit slower.
            </span>
          </span>
        </label>

        <OcrImageRagSettingsBlock />

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

function OcrImageRagSettingsBlock() {
  const [cfg, setCfg] = useState<OcrImageRagConfig>(DEFAULT_OCR_IMAGE_RAG_CONFIG);
  const [caps, setCaps] = useState<OcrCapabilities | null>(null);
  const [uoProbe, setUoProbe] = useState<UnlimitedOcrProbe | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setCfg(await loadOcrImageRagConfig());
        setCaps(await loadOcrCapabilities());
        try {
          setUoProbe(await probeUnlimitedOcr());
        } catch {
          /* optional */
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const saveOcr = async () => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const url = (cfg.image_rag_base_url || '').trim();
      if (cfg.image_rag_enabled && url && !/^https?:\/\//i.test(url)) {
        setErr('API address must start with http:// or https://');
        return;
      }
      const clamped = {
        ...cfg,
        image_rag_max_regions_per_query: Math.min(8, Math.max(1, Number(cfg.image_rag_max_regions_per_query) || 4)),
        ocr_engine: ['auto', 'legacy', 'docling', 'unlimited'].includes(cfg.ocr_engine) ? cfg.ocr_engine : 'auto',
      };
      const saved = await saveOcrImageRagConfig(clamped, apiKey.trim() ? apiKey : null);
      setCfg(saved);
      setApiKey('');
      try {
        setCaps(await loadOcrCapabilities());
        setUoProbe(await probeUnlimitedOcr());
      } catch {
        /* optional */
      }
      setMsg('Saved. Rebuild your folder index if you changed how PDFs are read.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const downloadUnlimited = async () => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const probe = await downloadUnlimitedOcrModel();
      setUoProbe(probe);
      setCaps(await loadOcrCapabilities());
      setMsg(probe.available
        ? 'Unlimited-OCR weights downloaded and ready.'
        : `Weights downloaded to ${probe.model_dir}. CUDA + torch still required for use.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const testConn = async () => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      setMsg(await testImageRagConnection());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const statusLine = caps
    ? [
        caps.python_available ? 'PDF text reading ready' : 'PDF text reading needs Python',
        caps.docling_importable ? 'layout reader installed' : null,
        caps.opencv_available ? 'image cleanup installed' : null,
        caps.unlimited_ocr_available || uoProbe?.available ? 'Unlimited-OCR ready' : null,
        caps.active_engine_hint ? `active: ${caps.active_engine_hint}` : null,
      ].filter(Boolean).join(' · ')
    : null;

  const unlimitedStatus = uoProbe
    ? [
        uoProbe.worker_found ? 'worker found' : 'worker missing',
        uoProbe.cuda ? 'CUDA yes' : 'CUDA no',
        uoProbe.model_ready ? 'weights yes' : 'weights not downloaded',
        uoProbe.available ? 'ready' : 'not ready',
      ].join(' · ')
    : null;

  return (
    <div className="mt-4 pt-4 border-t border-surface-200 dark:border-surface-700 space-y-3">
      <h3 className="font-medium text-sm">Scanned PDFs &amp; optional page images</h3>
      <p className="text-xs text-surface-500">
        Scanned PDFs are read on this device by default. Sending page images to an online vision service is optional and off unless you turn it on here and again for each folder.
      </p>
      {statusLine && <p className="text-xs text-surface-500">{statusLine}</p>}
      {caps?.warnings?.length ? (
        <ul className="text-xs text-amber-700 dark:text-amber-300 list-disc pl-4 space-y-1">
          {caps.warnings.map(w => <li key={w}>{w}</li>)}
        </ul>
      ) : null}
      <label className="block text-sm">
        <span className="text-xs text-surface-500">How to read scanned PDFs</span>
        <select
          className="mt-1 w-full input"
          value={cfg.ocr_engine}
          onChange={e => setCfg({ ...cfg, ocr_engine: e.target.value })}
        >
          <option value="auto">Automatic (Unlimited → Docling → Legacy)</option>
          <option value="unlimited">Unlimited-OCR (CUDA preferred; CPU supported, slower)</option>
          <option value="legacy">Built-in reader</option>
          <option value="docling">Layout-aware reader (if installed)</option>
        </select>
      </label>
      <div className="rounded-xl border border-surface-200 dark:border-surface-700 p-3 space-y-2">
        <p className="text-xs font-medium">Unlimited-OCR (optional)</p>
        <p className="text-xs text-surface-500">
          Needs an NVIDIA GPU with CUDA, Python packages (torch, transformers, pymupdf), and downloaded weights (not bundled in the installer).
        </p>
        {unlimitedStatus && <p className="text-xs text-surface-500">{unlimitedStatus}</p>}
        {uoProbe?.warning && <p className="text-xs text-amber-700 dark:text-amber-300">{uoProbe.warning}</p>}
        {uoProbe?.model_dir && (
          <p className="text-[11px] text-surface-400 break-all">Model dir: {uoProbe.model_dir}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary text-xs"
            disabled={busy}
            onClick={() => void (async () => {
              setBusy(true);
              setErr(null);
              try {
                setUoProbe(await probeUnlimitedOcr());
                setCaps(await loadOcrCapabilities());
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            })()}
          >
            Probe Unlimited-OCR
          </button>
          <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => void downloadUnlimited()}>
            Download Unlimited-OCR weights
          </button>
        </div>
      </div>
      <label className="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" checked={cfg.ocr_preprocess} onChange={e => setCfg({ ...cfg, ocr_preprocess: e.target.checked })} className="mt-1" />
        <span className="text-sm">Clean up page images before reading (when available)</span>
      </label>
      <label className="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" checked={cfg.ocr_caption_figures} onChange={e => setCfg({ ...cfg, ocr_caption_figures: e.target.checked })} className="mt-1" />
        <span className="text-sm">Make tables and figures easier to find in search</span>
      </label>
      <label className="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" checked={cfg.ocr_llm_repair} onChange={e => setCfg({ ...cfg, ocr_llm_repair: e.target.checked })} className="mt-1" />
        <span className="text-sm">Fix obvious OCR typos (stays on this device)</span>
      </label>
      <label className="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" checked={cfg.verify_llm_answer} onChange={e => setCfg({ ...cfg, verify_llm_answer: e.target.checked })} className="mt-1" />
        <span className="text-sm">Double-check answers against your sources before showing them</span>
      </label>
      <label className="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" checked={cfg.image_rag_enabled} onChange={e => setCfg({ ...cfg, image_rag_enabled: e.target.checked })} className="mt-1" />
        <span className="text-sm font-medium">Allow online page-image look-up (master switch)</span>
      </label>
      <label className="block text-sm">
        <span className="text-xs text-surface-500">Vision API address</span>
        <input
          className="mt-1 w-full input"
          value={cfg.image_rag_base_url}
          onChange={e => setCfg({ ...cfg, image_rag_base_url: e.target.value })}
          placeholder="https://api.openai.com/v1"
        />
      </label>
      <label className="block text-sm">
        <span className="text-xs text-surface-500">Vision model name</span>
        <input
          className="mt-1 w-full input"
          value={cfg.image_rag_model}
          onChange={e => setCfg({ ...cfg, image_rag_model: e.target.value })}
          placeholder="gpt-4o-mini"
        />
      </label>
      <label className="block text-sm">
        <span className="text-xs text-surface-500">
          API key {cfg.image_rag_api_key_configured ? '(saved — leave blank to keep)' : ''}
        </span>
        <input
          type="password"
          className="mt-1 w-full input"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder="Paste key"
          autoComplete="off"
        />
      </label>
      <label className="block text-sm">
        <span className="text-xs text-surface-500">Max page images per question (1–8)</span>
        <input
          type="number"
          min={1}
          max={8}
          className="mt-1 w-full input"
          value={cfg.image_rag_max_regions_per_query}
          onChange={e => setCfg({
            ...cfg,
            image_rag_max_regions_per_query: Math.min(8, Math.max(1, Number(e.target.value) || 4)),
          })}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void saveOcr()}>
          Save PDF / image settings
        </button>
        <button type="button" className="btn-secondary" disabled={busy || !cfg.image_rag_enabled} onClick={() => void testConn()}>
          Test connection
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy || !cfg.image_rag_api_key_configured}
          onClick={() => void (async () => {
            setBusy(true);
            setErr(null);
            setMsg(null);
            try {
              const saved = await saveOcrImageRagConfig(cfg, '');
              setCfg(saved);
              setApiKey('');
              setMsg('API key removed.');
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          })()}
        >
          Remove API key
        </button>
      </div>
      {msg && <p className="text-sm text-emerald-600 dark:text-emerald-300">{msg}</p>}
      {err && <p className="text-sm text-red-600 dark:text-red-300">{err}</p>}
    </div>
  );
}
