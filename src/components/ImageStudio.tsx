import { useMemo, useState } from 'react';
import { Download, Loader2, Sparkles } from 'lucide-react';
import { save } from '@tauri-apps/api/dialog';
import { IMAGE_GENERATION_MODELS } from '../modelCatalog';
import { imageStudioGenerate, imageStudioSaveB64 } from '../codeWorkspace/ideApi';
import ReportAiContentModal, { type ReportAiContentTarget } from './ReportAiContentModal';

const ASPECTS = [
  { id: '16:9', label: '16:9 (Widescreen)', w: 16, h: 9 },
  { id: '1:1', label: '1:1 (Square)', w: 1, h: 1 },
  { id: '4:3', label: '4:3', w: 4, h: 3 },
  { id: '9:16', label: '9:16 (Portrait)', w: 9, h: 16 },
  { id: '3:2', label: '3:2', w: 3, h: 2 },
] as const;

const QUALITY: Record<'standard' | 'high' | 'ultra', number> = {
  standard: 768,
  high: 1024,
  ultra: 1536,
};

function dims(aspect: typeof ASPECTS[number], quality: keyof typeof QUALITY) {
  const long = QUALITY[quality];
  if (aspect.w >= aspect.h) {
    return { width: long, height: Math.round(long * aspect.h / aspect.w) };
  }
  return { width: Math.round(long * aspect.w / aspect.h), height: long };
}

function srcOf(url: string | null, b64: string | null, mime: string) {
  if (url) return url;
  if (b64) return `data:${mime};base64,${b64}`;
  return '';
}

type Shot = { id: string; src: string; b64: string | null; url: string | null; mime: string; seed: number };

export default function ImageStudio() {
  const workingModels = useMemo(
    () => IMAGE_GENERATION_MODELS.filter(m => m.mode === 'online'),
    [],
  );
  const [prompt, setPrompt] = useState('Modern architectural exterior with clean lines, dark graphite materials, and subtle emerald green accents. Moody daylight, minimalist, premium design, high detail.');
  const [providerId, setProviderId] = useState(workingModels[0]?.id || 'pollinations-flux');
  const [aspectId, setAspectId] = useState<(typeof ASPECTS)[number]['id']>('16:9');
  const [quality, setQuality] = useState<keyof typeof QUALITY>('high');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [reportTarget, setReportTarget] = useState<ReportAiContentTarget | null>(null);

  const model = workingModels.find(m => m.id === providerId) || workingModels[0];
  const aspect = ASPECTS.find(a => a.id === aspectId) || ASPECTS[0];

  const generate = async () => {
    if (!prompt.trim()) {
      setNotice('Enter an image prompt first.');
      return;
    }
    if (!model) {
      setNotice('No image provider is available.');
      return;
    }
    setBusy(true);
    setNotice(null);
    const { width, height } = dims(aspect, quality);
    const baseSeed = Math.floor(Math.random() * 1_000_000);
    try {
      const results = await Promise.all(
        [0, 1, 2, 3].map(async (i) => {
          const seed = baseSeed + i;
          const out = await imageStudioGenerate({
            provider: model.provider,
            modelId: model.modelId,
            prompt: prompt.trim(),
            width,
            height,
            seed,
            quality,
          });
          return {
            id: `${Date.now()}-${i}`,
            src: srcOf(out.url, out.b64, out.mime),
            b64: out.b64,
            url: out.url,
            mime: out.mime,
            seed,
          } satisfies Shot;
        }),
      );
      setShots(results);
      setSelected(results[0]?.id || null);
    } catch (err) {
      setNotice(String(err));
    } finally {
      setBusy(false);
    }
  };

  const exportSelected = async () => {
    const shot = shots.find(s => s.id === selected) || shots[0];
    if (!shot) {
      setNotice('Generate images before exporting.');
      return;
    }
    const dest = await save({
      defaultPath: `pocketmind-${shot.seed}.png`,
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (!dest) return;
    try {
      if (shot.b64) {
        await imageStudioSaveB64(dest, shot.b64);
      } else if (shot.url) {
        const res = await fetch(shot.url);
        const buf = await res.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        await imageStudioSaveB64(dest, b64);
      } else {
        throw new Error('Image has no data to export.');
      }
      setNotice(`Exported to ${dest}`);
    } catch (err) {
      setNotice(String(err));
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-hidden bg-black text-surface-50 p-4">
      <div className="h-full min-h-0 rounded-2xl border border-white/10 bg-[#0b0b0b] flex flex-col">
        <header className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
          <h1 className="text-lg font-semibold">Image Studio</h1>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary text-sm flex items-center gap-1.5" onClick={() => void exportSelected()}>
              <Download className="w-4 h-4" /> Export
            </button>
            {shots[0] && (
              <button type="button" className="text-xs text-surface-400" onClick={() => setReportTarget({
                contentExcerpt: prompt,
                sourceLabel: model?.name || 'Image Studio',
                contentKind: 'image',
              })}>
                Report
              </button>
            )}
          </div>
        </header>
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="border-r border-white/10 p-3 space-y-3 overflow-y-auto">
            <label className="block">
              <span className="text-xs font-medium text-surface-400">Prompt</span>
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value.slice(0, 1000))}
                rows={7}
                className="input-field mt-1 resize-none text-sm"
                maxLength={1000}
              />
              <span className="text-[11px] text-surface-500">{prompt.length} / 1000</span>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-surface-400">Image provider</span>
              <select value={providerId} onChange={e => setProviderId(e.target.value)} className="input-field mt-1 text-sm">
                {workingModels.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.providerName} · {m.name}{m.requiresApiKey ? ' (key)' : ' (free)'}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-surface-400">Aspect ratio</span>
              <select value={aspectId} onChange={e => setAspectId(e.target.value as typeof aspectId)} className="input-field mt-1 text-sm">
                {ASPECTS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </label>
            <div>
              <span className="text-xs font-medium text-surface-400">Quality</span>
              <div className="mt-1 grid grid-cols-3 rounded-lg border border-white/10 overflow-hidden">
                {(['standard', 'high', 'ultra'] as const).map(q => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setQuality(q)}
                    className={`py-1.5 text-xs capitalize ${quality === q ? 'bg-primary-600 text-white' : 'text-surface-300 hover:bg-white/5'}`}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
            <button type="button" disabled={busy} onClick={() => void generate()} className="btn-primary w-full flex items-center justify-center gap-2">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              Generate
            </button>
            {notice && <p className="text-xs text-amber-200">{notice}</p>}
            <p className="text-[11px] text-surface-500">
              Free Pollinations needs no key. OpenAI, Together, Hugging Face, Replicate, and Stability use keys from Control Center → API Keys.
            </p>
          </aside>
          <div className="min-h-0 p-2 grid grid-cols-2 grid-rows-2 gap-2">
            {shots.length === 0 && (
              <div className="col-span-2 row-span-2 flex items-center justify-center text-sm text-surface-500">
                Generate four variants to compare side by side, then Export the one you keep.
              </div>
            )}
            {shots.map(s => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelected(s.id)}
                className={`relative rounded-xl overflow-hidden border ${selected === s.id ? 'border-primary-400' : 'border-white/10'}`}
              >
                <img src={s.src} alt="" className="w-full h-full object-cover bg-black" />
              </button>
            ))}
          </div>
        </div>
      </div>
      <ReportAiContentModal open={!!reportTarget} target={reportTarget} onClose={() => setReportTarget(null)} />
    </div>
  );
}
