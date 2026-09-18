import { useMemo, useState, type ReactNode } from 'react';
import { Download, Image as ImageIcon, Wand2, Crown, Zap, HardDrive, SlidersHorizontal, ExternalLink, Copy, Check, AlertTriangle, Loader2, RefreshCw, Maximize2, Flag } from 'lucide-react';
import { IMAGE_GENERATION_MODELS, MODEL_CATEGORIES } from '../modelCatalog';
import { GeneratedImageRecord, ImageGenerationModel, ModelCategoryId } from '../types';
import { onOpenExternal } from '../openExternal';
import ReportAiContentModal, { type ReportAiContentTarget } from './ReportAiContentModal';

const IMAGE_CATEGORIES = MODEL_CATEGORIES.filter(c => c.id.startsWith('image-'));

type ImageMode = 'online-free' | 'online-premium' | 'offline';
type ImageLoadState = 'loading' | 'loaded' | 'error';

function cleanPrompt(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function buildPollinationsUrl(model: ImageGenerationModel, prompt: string, width: number, height: number, seed: number, negativePrompt: string) {
  const safePrompt = cleanPrompt(prompt || 'A beautiful futuristic AI desktop app interface');
  const encodedPrompt = encodeURIComponent(safePrompt);
  const url = new URL(`https://image.pollinations.ai/prompt/${encodedPrompt}`);
  url.searchParams.set('width', String(Math.max(256, Math.min(1536, width || model.defaultWidth))));
  url.searchParams.set('height', String(Math.max(256, Math.min(1536, height || model.defaultHeight))));
  url.searchParams.set('seed', String(seed || Math.floor(Math.random() * 1_000_000)));
  url.searchParams.set('model', model.modelId || 'flux');
  url.searchParams.set('nologo', 'true');
  url.searchParams.set('safe', 'false');
  url.searchParams.set('enhance', 'true');
  url.searchParams.set('cacheBust', String(Date.now()));
  if (negativePrompt.trim()) url.searchParams.set('negative', negativePrompt.trim());
  return url.toString();
}

function shortPrompt(value: string) {
  const text = cleanPrompt(value);
  return text.length > 78 ? `${text.slice(0, 78)}...` : text;
}

export default function ImageStudio() {
  const [mode, setMode] = useState<ImageMode>('online-free');
  const [category, setCategory] = useState<ModelCategoryId | 'all'>('all');
  const [selectedModelId, setSelectedModelId] = useState('pollinations-flux');
  const [prompt, setPrompt] = useState('A clean futuristic AI workspace, premium desktop interface, soft blue accents, detailed realistic lighting');
  const [negativePrompt, setNegativePrompt] = useState('blurry, low quality, distorted text, watermark');
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1_000_000));
  const [gallery, setGallery] = useState<GeneratedImageRecord[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<GeneratedImageRecord | null>(null);
  const [reportTarget, setReportTarget] = useState<ReportAiContentTarget | null>(null);

  const visibleModels = useMemo(() => IMAGE_GENERATION_MODELS.filter(model => {
    const modeMatches = mode === 'offline'
      ? model.mode === 'offline'
      : model.mode === 'online' && model.tier === (mode === 'online-free' ? 'free' : 'premium');
    const categoryMatches = category === 'all' || model.categories.includes(category);
    return modeMatches && categoryMatches;
  }), [mode, category]);

  const selectedModel = IMAGE_GENERATION_MODELS.find(m => m.id === selectedModelId) || visibleModels[0] || IMAGE_GENERATION_MODELS[0];

  const selectModel = (model: ImageGenerationModel) => {
    setSelectedModelId(model.id);
    setWidth(model.defaultWidth);
    setHeight(model.defaultHeight);
    setNotice(null);
  };

  const generate = () => {
    if (!prompt.trim()) {
      setNotice('Enter an image prompt first.');
      return;
    }
    if (!selectedModel.supportsDirectGeneration) {
      setNotice(
        selectedModel.mode === 'offline'
          ? 'Offline image generation is listed for planning and model management. Local Stable Diffusion/FLUX execution is not enabled in this build yet.'
          : `${selectedModel.providerName} image generation requires provider API execution. This model is listed in the catalog, but direct execution is not enabled in this build.`
      );
      return;
    }

    const nextWidth = Math.max(256, Math.min(1536, Number(width) || selectedModel.defaultWidth));
    const nextHeight = Math.max(256, Math.min(1536, Number(height) || selectedModel.defaultHeight));
    const nextSeed = Number(seed) || Math.floor(Math.random() * 1_000_000);
    const url = buildPollinationsUrl(selectedModel, prompt, nextWidth, nextHeight, nextSeed, negativePrompt);
    const record: GeneratedImageRecord = {
      id: `${Date.now()}`,
      prompt,
      negativePrompt,
      modelId: selectedModel.id,
      provider: selectedModel.providerName,
      width: nextWidth,
      height: nextHeight,
      seed: nextSeed,
      url,
      createdAt: Date.now(),
    };
    setGallery(prev => [record, ...prev]);
    setSeed(Math.floor(Math.random() * 1_000_000));
    setNotice('Image request started. The preview will update when the free online provider returns the image.');
  };

  const copyUrl = async (record: GeneratedImageRecord) => {
    await navigator.clipboard.writeText(record.url);
    setCopied(record.id);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-3 sm:p-5 lg:p-6">
      <div className="mx-auto w-full max-w-[1500px] space-y-5 sm:space-y-6">
        <div className="relative overflow-hidden rounded-[2rem] border border-white/20 bg-gradient-to-br from-primary-700 via-primary-600 to-primary-500 p-4 sm:p-6 text-white shadow-2xl shadow-primary-900/20">
          <div className="absolute -right-20 -top-20 w-64 h-64 rounded-full bg-white/20 blur-3xl" />
          <div className="relative flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs sm:text-sm uppercase tracking-[0.2em] sm:tracking-[0.25em] text-primary-200 font-semibold">PocketMind Hybrid AI Image Studio</p>
              <h1 className="text-2xl sm:text-3xl font-black mt-2 leading-tight">Image generation studio</h1>
              <p className="text-primary-100/80 mt-2 max-w-3xl text-sm sm:text-base">Generate with supported online providers, manage image model options, and clearly track offline image runtimes that are not enabled yet.</p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center text-xs shrink-0">
              <Stat label="Free online" value={IMAGE_GENERATION_MODELS.filter(m => m.mode === 'online' && m.tier === 'free').length} />
              <Stat label="Premium" value={IMAGE_GENERATION_MODELS.filter(m => m.tier === 'premium').length} />
              <Stat label="Offline" value={IMAGE_GENERATION_MODELS.filter(m => m.mode === 'offline').length} />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 2xl:grid-cols-[minmax(320px,430px)_minmax(0,1fr)] gap-5 sm:gap-6 min-w-0">
          <div className="space-y-4 min-w-0">
            <div className="premium-card rounded-3xl p-4 space-y-4 min-w-0">
              <div className="grid grid-cols-1 sm:grid-cols-3 2xl:grid-cols-1 gap-2">
                <ModeButton active={mode === 'online-free'} onClick={() => setMode('online-free')} icon={<Zap className="w-4 h-4" />} label="Free online" />
                <ModeButton active={mode === 'online-premium'} onClick={() => setMode('online-premium')} icon={<Crown className="w-4 h-4" />} label="Premium online" />
                <ModeButton active={mode === 'offline'} onClick={() => setMode('offline')} icon={<HardDrive className="w-4 h-4" />} label="Offline" />
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible">
                <button onClick={() => setCategory('all')} className={`whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium ${category === 'all' ? 'bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300' : 'bg-surface-100 dark:bg-surface-800 text-surface-500'}`}>All styles</button>
                {IMAGE_CATEGORIES.map(cat => (
                  <button key={cat.id} onClick={() => setCategory(cat.id)} className={`whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium ${category === cat.id ? 'bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300' : 'bg-surface-100 dark:bg-surface-800 hover:bg-surface-200 dark:hover:bg-surface-700 text-surface-500'}`}>{cat.icon} {cat.label}</button>
                ))}
              </div>
            </div>

            <div className="premium-card rounded-3xl p-4 space-y-3 min-w-0">
              <h2 className="font-semibold flex items-center gap-2"><Wand2 className="w-5 h-5 text-primary-500" /> Prompt</h2>
              <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={5} className="input-field resize-none" placeholder="Describe the image you want..." />
              <textarea value={negativePrompt} onChange={e => setNegativePrompt(e.target.value)} rows={2} className="input-field resize-none" placeholder="Negative prompt: blurry, bad anatomy, watermark..." />
              <div className="grid grid-cols-1 sm:grid-cols-3 2xl:grid-cols-3 gap-3 text-sm">
                <label className="min-w-0">Width<input type="number" min="256" max="1536" step="64" value={width} onChange={e => setWidth(Number(e.target.value))} className="input-field mt-1" /></label>
                <label className="min-w-0">Height<input type="number" min="256" max="1536" step="64" value={height} onChange={e => setHeight(Number(e.target.value))} className="input-field mt-1" /></label>
                <label className="min-w-0">Seed<input type="number" value={seed} onChange={e => setSeed(Number(e.target.value))} className="input-field mt-1" /></label>
              </div>
              <button onClick={generate} className="btn-primary w-full flex items-center justify-center gap-2"><ImageIcon className="w-4 h-4" /> Generate Image</button>
              {notice && <div className="rounded-xl border border-amber-300/40 bg-amber-50 dark:bg-amber-950/20 p-3 text-sm text-amber-700 dark:text-amber-300 flex gap-2"><AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /> <span>{notice}</span></div>}
            </div>
          </div>

          <div className="space-y-6 min-w-0">
            <div className="premium-card rounded-3xl overflow-hidden min-w-0">
              <div className="p-4 border-b border-white/70 dark:border-surface-800">
                <h2 className="font-semibold flex items-center gap-2"><SlidersHorizontal className="w-5 h-5 text-primary-500" /> Image model catalog</h2>
                <p className="text-sm text-surface-500">Choose the model workflow. Direct generation is enabled for no-key free providers first.</p>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4 p-4 min-w-0">
                {visibleModels.map(model => (
                  <button key={model.id} onClick={() => selectModel(model)} className={`text-left rounded-2xl border p-4 transition-all min-w-0 ${selectedModel.id === model.id ? 'border-primary-500 bg-primary-50 dark:bg-primary-950/20 shadow-lg shadow-primary-500/10' : 'border-surface-200 dark:border-surface-800 bg-white/50 dark:bg-surface-950/40 hover:border-primary-400/60'}`}>
                    <div className="flex items-start justify-between gap-3 min-w-0">
                      <div className="min-w-0">
                        <p className="font-semibold truncate">{model.name}</p>
                        <p className="text-xs text-surface-500 truncate">{model.providerName} • {model.modelId}</p>
                      </div>
                      <span className={`shrink-0 text-[10px] uppercase tracking-wide px-2 py-1 rounded-full ${model.mode === 'offline' ? 'bg-surface-200 dark:bg-surface-800 text-surface-600 dark:text-surface-300' : model.tier === 'free' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'}`}>{model.mode === 'offline' ? 'offline' : model.tier}</span>
                    </div>
                    <p className="text-sm text-surface-600 dark:text-surface-400 mt-3 line-clamp-3">{model.recommendedUse}</p>
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {model.categories.map(cat => <span key={cat} className="text-[10px] px-2 py-1 rounded-full bg-surface-100 dark:bg-surface-800 text-surface-500">{cat}</span>)}
                    </div>
                    <p className="text-xs mt-3 text-surface-500">{model.supportsDirectGeneration ? 'Ready now' : model.mode === 'offline' ? 'Runtime wiring planned' : 'API execution planned'}</p>
                  </button>
                ))}
              </div>
            </div>

            <div className="premium-card rounded-3xl overflow-hidden min-w-0">
              <div className="p-4 border-b border-white/70 dark:border-surface-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-semibold">Generated images</h2>
                  <p className="text-sm text-surface-500">Images stay inside fixed preview frames. Open in browser for full resolution.</p>
                </div>
                {gallery.length > 0 && <button onClick={() => setGallery([])} className="btn-secondary text-sm shrink-0">Clear</button>}
              </div>
              {gallery.length === 0 ? (
                <div className="p-8 sm:p-10 text-center text-surface-500">No images yet. Choose a free online model and click Generate Image.</div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 p-4 min-w-0">
                  {gallery.map(record => (
                    <GalleryCard
                      key={record.id}
                      record={record}
                      copied={copied === record.id}
                      onCopy={() => copyUrl(record)}
                      onPreview={() => setPreview(record)}
                      onReport={() => setReportTarget({
                        contentExcerpt: `Prompt: ${record.prompt}\nImage URL: ${record.url}\nProvider: ${record.provider}`,
                        sourceLabel: 'Image Studio',
                        contentKind: 'image',
                      })}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {preview && (
        <div className="fixed inset-0 z-[80] bg-black/80 backdrop-blur-sm p-4 flex items-center justify-center" onClick={() => setPreview(null)}>
          <div className="w-full max-w-5xl max-h-[92vh] rounded-3xl overflow-hidden bg-surface-950 border border-white/10 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 p-3 border-b border-white/10">
              <div className="min-w-0">
                <p className="text-white font-semibold truncate">{shortPrompt(preview.prompt)}</p>
                <p className="text-xs text-surface-400">{preview.provider} • {preview.width}×{preview.height} • seed {preview.seed}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  className="btn-secondary text-sm inline-flex items-center gap-1"
                  onClick={() => setReportTarget({
                    contentExcerpt: `Prompt: ${preview.prompt}\nImage URL: ${preview.url}\nProvider: ${preview.provider}`,
                    sourceLabel: 'Image Studio preview',
                    contentKind: 'image',
                  })}
                >
                  <Flag className="w-3.5 h-3.5" /> Report
                </button>
                <button onClick={() => setPreview(null)} className="btn-secondary text-sm">Close</button>
              </div>
            </div>
            <div className="max-h-[78vh] overflow-auto bg-black grid place-items-center p-3">
              <img src={preview.url} alt="Generated preview" className="max-w-full h-auto rounded-2xl" referrerPolicy="no-referrer" />
            </div>
          </div>
        </div>
      )}

      <ReportAiContentModal
        open={Boolean(reportTarget)}
        target={reportTarget}
        onClose={() => setReportTarget(null)}
      />
    </div>
  );
}

function GalleryCard({ record, copied, onCopy, onPreview, onReport }: { record: GeneratedImageRecord; copied: boolean; onCopy: () => void; onPreview: () => void; onReport: () => void }) {
  const [state, setState] = useState<ImageLoadState>('loading');
  const [retryKey, setRetryKey] = useState(0);
  const imgSrc = `${record.url}${record.url.includes('?') ? '&' : '?'}retry=${retryKey}`;

  return (
    <div className="rounded-2xl border border-surface-200 dark:border-surface-800 overflow-hidden bg-white/50 dark:bg-surface-950/40 min-w-0 shadow-sm">
      <div className="relative aspect-square w-full overflow-hidden bg-surface-100 dark:bg-surface-900">
        {state === 'loading' && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-gradient-to-br from-surface-100 to-surface-200 dark:from-surface-900 dark:to-surface-950 text-surface-500">
            <div className="flex flex-col items-center gap-3 text-center px-4">
              <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
              <p className="text-sm font-medium">Rendering image...</p>
              <p className="text-xs text-surface-500">Free providers can take a few seconds.</p>
            </div>
          </div>
        )}
        {state === 'error' && (
          <div className="absolute inset-0 z-20 grid place-items-center bg-surface-100 dark:bg-surface-900 text-surface-500 p-4 text-center">
            <div className="space-y-3">
              <AlertTriangle className="w-8 h-8 mx-auto text-amber-500" />
              <p className="text-sm font-semibold text-surface-700 dark:text-surface-200">Image did not load in the app frame.</p>
              <p className="text-xs">Open it in the browser or retry. The provider may still be generating or blocked temporarily.</p>
              <button onClick={() => { setState('loading'); setRetryKey(v => v + 1); }} className="btn-secondary text-xs inline-flex items-center gap-1"><RefreshCw className="w-3 h-3" /> Retry</button>
            </div>
          </div>
        )}
        <img
          key={retryKey}
          src={imgSrc}
          alt=""
          className={`h-full w-full object-cover transition-opacity duration-300 ${state === 'loaded' ? 'opacity-100' : 'opacity-0'}`}
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => setState('loaded')}
          onError={() => setState('error')}
        />
        <button onClick={onPreview} className="absolute right-2 top-2 rounded-xl bg-black/50 hover:bg-black/70 text-white p-2 opacity-0 hover:opacity-100 focus:opacity-100 transition-opacity">
          <Maximize2 className="w-4 h-4" />
        </button>
      </div>
      <div className="p-3 space-y-2 min-w-0">
        <p className="text-sm font-medium line-clamp-2 break-words">{record.prompt}</p>
        <p className="text-xs text-surface-500 truncate">{record.provider} • {record.width}×{record.height} • seed {record.seed}</p>
        <div className="grid grid-cols-4 gap-2">
          <button onClick={onCopy} className="btn-secondary text-xs flex items-center justify-center gap-1 min-w-0 px-2">{copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} <span className="hidden sm:inline">Copy</span></button>
          <button type="button" onClick={onOpenExternal(record.url)} className="btn-secondary text-xs flex items-center justify-center gap-1 min-w-0 px-2"><ExternalLink className="w-3 h-3" /> <span className="hidden sm:inline">Open</span></button>
          <button type="button" onClick={onOpenExternal(record.url)} className="btn-secondary text-xs flex items-center justify-center gap-1 min-w-0 px-2" title="Open image URL (save from browser)"><Download className="w-3 h-3" /> <span className="hidden sm:inline">Save</span></button>
          <button type="button" onClick={onReport} className="btn-secondary text-xs flex items-center justify-center gap-1 min-w-0 px-2" title="Report AI-generated content"><Flag className="w-3 h-3" /> <span className="hidden sm:inline">Report</span></button>
        </div>
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return <button onClick={onClick} className={`w-full px-4 py-2 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-all ${active ? 'bg-primary-600 text-white shadow-lg shadow-primary-500/20' : 'bg-surface-100 dark:bg-surface-800 hover:bg-surface-200 dark:hover:bg-surface-700 text-surface-600 dark:text-surface-300'}`}>{icon}{label}</button>;
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-2xl bg-white/10 border border-white/10 p-2 sm:p-3 min-w-0"><div className="text-lg sm:text-xl font-black">{value}</div><div className="text-primary-100/70 truncate">{label}</div></div>;
}
