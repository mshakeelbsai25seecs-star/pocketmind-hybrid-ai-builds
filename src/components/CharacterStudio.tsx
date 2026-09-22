import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { open } from '@tauri-apps/api/dialog';
import { Plus, Save } from 'lucide-react';
import { useAppStore } from '../store';
import type { Character, GenerationChunk } from '../types';
import { COMMON_CHARACTER_PRESETS } from './CharacterEditor';
import { pickChatBackend } from '../docStudio';

const STARTERS = [
  { name: 'Strategist', role: 'Turns goals into clear plans and next steps.', tone: 'Clear, concise, pragmatic.', tag: 'Planning' },
  { name: 'Researcher', role: 'Finds insights and validates with sources.', tone: 'Curious, careful, sourced.', tag: 'Research' },
  { name: 'Editor', role: 'Improves clarity, structure and tone.', tone: 'Precise, kind, direct.', tag: 'Writing' },
  { name: 'Analyst', role: 'Analyzes data and uncovers patterns.', tone: 'Structured, quantitative.', tag: 'Analysis' },
  { name: 'Product Manager', role: 'Defines problems and prioritizes solutions.', tone: 'Outcome-focused.', tag: 'Product' },
  { name: 'Coach', role: 'Asks better questions and builds clarity.', tone: 'Supportive, practical.', tag: 'Coaching' },
];

function traitsText(raw: string) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.join(', ') : String(raw || '');
  } catch {
    return raw || '';
  }
}

export default function CharacterStudio() {
  const store = useAppStore();
  const { characters, setCharacters, activeCharacterId, setActiveCharacter, currentModel, defaultParams } = store;
  const [selectedId, setSelectedId] = useState<string | null>(activeCharacterId);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [tone, setTone] = useState('');
  const [instructions, setInstructions] = useState('');
  const [knowledge, setKnowledge] = useState('');
  const [previewIn, setPreviewIn] = useState('We need a go-to-market strategy for our new project management app.');
  const [previewOut, setPreviewOut] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const selected = characters.find(c => c.id === selectedId) || null;

  useEffect(() => {
    invoke<Character[]>('get_characters').then(setCharacters).catch(() => undefined);
  }, [setCharacters]);

  useEffect(() => {
    if (!selected) return;
    setName(selected.name);
    setRole(selected.description);
    setTone(traitsText(selected.personality_traits));
    setInstructions(selected.system_prompt);
    setKnowledge(selected.memory || '');
  }, [selectedId]);

  const cards = useMemo(() => {
    if (characters.length > 0) return characters.map(c => ({
      id: c.id,
      name: c.name,
      role: c.description,
      tag: traitsText(c.personality_traits).split(',')[0] || 'Custom',
    }));
    return STARTERS.map(s => ({ id: `starter:${s.name}`, name: s.name, role: s.role, tag: s.tag }));
  }, [characters]);

  const loadStarter = (n: string) => {
    const s = STARTERS.find(x => x.name === n);
    const preset = COMMON_CHARACTER_PRESETS.find(p => p.name.toLowerCase().includes(n.toLowerCase()));
    setSelectedId(null);
    setName(s?.name || n);
    setRole(s?.role || preset?.description || '');
    setTone(s?.tone || (preset?.traits || []).join(', '));
    setInstructions(preset?.prompt || `You are ${n}. ${s?.role || ''} Tone: ${s?.tone || 'clear and helpful.'}`);
    setKnowledge('');
  };

  const save = async () => {
    if (!name.trim() || !instructions.trim()) {
      setNotice('Name and instructions are required.');
      return;
    }
    const traits = JSON.stringify(tone.split(',').map(s => s.trim()).filter(Boolean));
    try {
      if (selected) {
        await invoke('update_character', {
          id: selected.id,
          updates: {
            ...selected,
            name: name.trim(),
            description: role.trim(),
            system_prompt: instructions.trim(),
            personality_traits: traits,
            memory: knowledge,
          },
        });
        setNotice('Character saved.');
      } else {
        const id = await invoke<string>('create_character', {
          name: name.trim(),
          description: role.trim(),
          systemPrompt: instructions.trim(),
          avatarPath: null,
          traits,
          folderId: null,
        });
        if (knowledge.trim()) {
          const created = (await invoke<Character[]>('get_characters')).find(c => c.id === id);
          if (created) {
            await invoke('update_character', { id, updates: { ...created, memory: knowledge } });
          }
        }
        setSelectedId(id);
        setActiveCharacter(id);
        setNotice('Character created.');
      }
      setCharacters(await invoke<Character[]>('get_characters'));
    } catch (err) {
      setNotice(String(err));
    }
  };

  const addKnowledgeFile = async () => {
    const picked = await open({ multiple: false });
    if (typeof picked !== 'string') return;
    setKnowledge(k => (k ? `${k}\n${picked}` : picked));
  };

  const sendPreview = async () => {
    const user = previewIn.trim();
    if (!user) return;
    setPreviewOut(prev => [...prev, `You: ${user}`]);
    setPreviewIn('');
    if (!currentModel) {
      const sample = instructions
        ? `${name || 'Character'}: ${role || 'I can help with this.'} ${tone ? `(${tone})` : ''}`
        : 'Save a character and select a model to preview a live reply.';
      setPreviewOut(prev => [...prev, sample]);
      return;
    }
    setBusy(true);
    try {
      const { backend, modelPath } = pickChatBackend(currentModel);
      const system = [instructions, tone && `Tone: ${tone}`, knowledge && `Knowledge:\n${knowledge}`].filter(Boolean).join('\n\n');
      const chunk = await invoke<GenerationChunk>('generate_response', {
        request: {
          prompt: user,
          system_prompt: system,
          params: defaultParams,
          model_path: modelPath || currentModel,
          backend,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          images: [],
        },
      });
      setPreviewOut(prev => [...prev, `${name || 'Character'}: ${chunk.text || '(empty reply)'}`]);
    } catch (err) {
      setPreviewOut(prev => [...prev, `Error: ${String(err)}`]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-hidden bg-black text-surface-50">
      <div className="h-full min-h-0 grid grid-cols-1 xl:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)_minmax(260px,0.8fr)]">
        <section className="min-h-0 overflow-y-auto p-4 border-r border-white/10">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-semibold">Characters</h1>
            <button type="button" className="btn-primary text-sm flex items-center gap-1" onClick={() => { setSelectedId(null); setName(''); setRole(''); setTone(''); setInstructions(''); setKnowledge(''); }}>
              <Plus className="w-4 h-4" /> New character
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {cards.map(c => (
              <button
                key={c.id}
                type="button"
                onClick={() => (c.id.startsWith('starter:') ? loadStarter(c.name) : setSelectedId(c.id))}
                className={`text-left rounded-2xl border p-3 ${selectedId === c.id || name === c.name ? 'border-primary-500' : 'border-white/10 hover:border-white/20'}`}
              >
                <div className="w-8 h-8 rounded-lg bg-primary-500/20 mb-2" />
                <p className="font-semibold text-sm">{c.name}</p>
                <p className="text-[11px] text-surface-400 line-clamp-2">{c.role}</p>
                <span className="inline-block mt-2 text-[10px] px-2 py-0.5 rounded-full bg-white/5">{c.tag}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="min-h-0 overflow-y-auto p-4 border-r border-white/10 space-y-3">
          <h2 className="font-semibold">Edit character</h2>
          <label className="block text-xs text-surface-400">Name
            <input value={name} maxLength={80} onChange={e => setName(e.target.value)} className="input-field mt-1 text-sm" />
            <span className="float-right text-[10px]">{name.length}/80</span>
          </label>
          <label className="block text-xs text-surface-400">Role
            <textarea value={role} maxLength={120} onChange={e => setRole(e.target.value)} className="input-field mt-1 text-sm resize-none" rows={2} />
            <span className="text-[10px]">{role.length}/120</span>
          </label>
          <label className="block text-xs text-surface-400">Tone
            <input value={tone} maxLength={80} onChange={e => setTone(e.target.value)} className="input-field mt-1 text-sm" />
          </label>
          <label className="block text-xs text-surface-400">Instructions
            <textarea value={instructions} maxLength={4000} onChange={e => setInstructions(e.target.value)} className="input-field mt-1 text-sm resize-none" rows={8} />
            <span className="text-[10px]">{instructions.length}/4000</span>
          </label>
          <div>
            <p className="text-xs text-surface-400 mb-1">Knowledge</p>
            <div className="flex flex-wrap gap-1 mb-2">
              {knowledge.split('\n').filter(Boolean).map(k => (
                <span key={k} className="text-[11px] px-2 py-0.5 rounded-full bg-white/10">{k.split(/[\\/]/).pop()}</span>
              ))}
            </div>
            <button type="button" className="btn-secondary text-xs" onClick={() => void addKnowledgeFile()}>+ Add file</button>
          </div>
          {notice && <p className="text-xs text-primary-300">{notice}</p>}
          <div className="flex gap-2">
            <button type="button" className="btn-secondary flex-1" onClick={() => selected && setSelectedId(selected.id)}>Cancel</button>
            <button type="button" className="btn-primary flex-1 flex items-center justify-center gap-1" onClick={() => void save()}>
              <Save className="w-4 h-4" /> Save
            </button>
          </div>
        </section>

        <section className="min-h-0 flex flex-col p-4">
          <h2 className="font-semibold mb-2">Preview</h2>
          <div className="flex-1 min-h-0 overflow-y-auto space-y-2 text-sm">
            {previewOut.length === 0 && (
              <div className="rounded-xl bg-white/5 p-3 text-surface-300">
                {instructions ? `Ask ${name || 'this character'} anything to preview the voice.` : 'Fill in instructions, then send a preview message.'}
              </div>
            )}
            {previewOut.map((line, i) => (
              <div key={i} className="rounded-xl bg-white/5 p-3 whitespace-pre-wrap">{line}</div>
            ))}
          </div>
          <form className="mt-2 flex gap-2" onSubmit={e => { e.preventDefault(); void sendPreview(); }}>
            <input
              value={previewIn}
              onChange={e => setPreviewIn(e.target.value)}
              placeholder={`Message ${name || 'character'}…`}
              className="input-field flex-1 text-sm"
              disabled={busy}
            />
            <button type="submit" className="btn-primary text-sm" disabled={busy}>{busy ? '…' : 'Send'}</button>
          </form>
        </section>
      </div>
    </div>
  );
}
