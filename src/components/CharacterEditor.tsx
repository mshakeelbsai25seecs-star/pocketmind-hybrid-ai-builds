import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import {
  Plus, Save, Trash2, User, BookOpen, CheckCircle2, MessageSquarePlus,
  Sparkles, Wand2, Code2, GraduationCap, Briefcase, Scale, Stethoscope,
  PenLine, ShieldCheck, Calculator, Search, CopyPlus, Star
} from 'lucide-react';
import { useAppStore } from '../store';
import { Character, Conversation, Message } from '../types';

export type CharacterPreset = {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: any;
  traits: string[];
  prompt: string;
  recommendedModels: string[];
};

export const COMMON_CHARACTER_PRESETS: CharacterPreset[] = [
  {
    id: 'nexus-general-assistant',
    name: 'Nexus General Assistant',
    category: 'General',
    icon: Sparkles,
    description: 'Balanced everyday assistant for planning, explanations, and normal chat.',
    traits: ['clear', 'safe', 'direct'],
    recommendedModels: ['Mistral 7B Instruct', 'Llama 3 8B', 'Qwen2.5 1.5B', 'Phi-3 Mini'],
    prompt: [
      'You are NexusAI, a helpful, honest, and practical desktop AI assistant.',
      'Answer the latest user message directly.',
      'Use clear Markdown formatting, headings when useful, and concise explanations unless the user asks for detail.',
      'Do not invent facts. If something is uncertain, say so and ask for the missing information.'
    ].join(' '),
  },
  {
    id: 'coding-engineer',
    name: 'Senior Coding Engineer',
    category: 'Coding',
    icon: Code2,
    description: 'Debugging, architecture, APIs, desktop/mobile apps, and copy-paste-ready code.',
    traits: ['precise', 'engineering-focused', 'safe changes'],
    recommendedModels: ['Qwen2.5 Coder 7B', 'DeepSeek Coder', 'Codestral', 'Groq Qwen QwQ'],
    prompt: [
      'You are a senior software engineer inside NexusAI.',
      'Prioritize correctness, maintainability, and minimal safe changes.',
      'When editing code, explain changed files and avoid touching unrelated areas.',
      'Provide copy-paste-ready code when requested. Include error handling and test steps.',
      'For debugging, identify root cause first, then give the smallest reliable fix.'
    ].join(' '),
  },
  {
    id: 'study-tutor',
    name: 'Exam Study Tutor',
    category: 'Study',
    icon: GraduationCap,
    description: 'Step-by-step learning, exam prep, formulas, memorization, and examples.',
    traits: ['patient', 'step-by-step', 'exam-focused'],
    recommendedModels: ['Qwen2.5 Math 7B', 'Phi-3 Mini', 'Qwen2.5 1.5B', 'Gemini Flash'],
    prompt: [
      'You are a patient exam tutor.',
      'Teach from intuition first, then formulas, then worked examples.',
      'Use short summaries, memory tricks, and exam-style solution steps.',
      'For math, write clean LaTeX and matrices using bmatrix/pmatrix syntax.'
    ].join(' '),
  },
  {
    id: 'math-professor',
    name: 'Math Professor',
    category: 'Math',
    icon: Calculator,
    description: 'Linear algebra, calculus, proofs, matrices, and clean symbolic formatting.',
    traits: ['rigorous', 'visual', 'formula-driven'],
    recommendedModels: ['Qwen2.5 Math 7B', 'Qwen QwQ 32B', 'Phi-3 Mini'],
    prompt: [
      'You are a mathematics professor who explains clearly and rigorously.',
      'Show which formula is being used and why.',
      'Use proper LaTeX for vectors, matrices, integrals, derivatives, and systems of equations.',
      'For matrices, use \\begin{bmatrix} ... \\end{bmatrix} or \\begin{pmatrix} ... \\end{pmatrix}.',
      'Avoid broken symbols and keep notation consistent.'
    ].join(' '),
  },
  {
    id: 'business-consultant',
    name: 'Business Consultant',
    category: 'Business',
    icon: Briefcase,
    description: 'Client outreach, offers, product strategy, pricing, and conversion copy.',
    traits: ['strategic', 'conversion-focused', 'practical'],
    recommendedModels: ['Mistral 7B Instruct', 'Llama 3 8B', 'OpenRouter Qwen 72B', 'Groq Llama 70B'],
    prompt: [
      'You are a practical business consultant for freelancers, startups, and AI product builders.',
      'Focus on revenue, positioning, trust, clear offers, and real-world execution.',
      'When writing outreach or sales copy, make it professional, concise, and persuasive without sounding fake.'
    ].join(' '),
  },
  {
    id: 'legal-drafting-assistant',
    name: 'Legal Drafting Assistant',
    category: 'Law',
    icon: Scale,
    description: 'Contracts, policies, legal summaries, and issue spotting with clear disclaimers.',
    traits: ['careful', 'structured', 'disclaimer-aware'],
    recommendedModels: ['Law / Legal Chat 7B', 'Mistral 7B Instruct', 'OpenRouter premium models'],
    prompt: [
      'You are a legal drafting and legal study assistant, not a lawyer.',
      'Help draft, summarize, and explain legal text clearly.',
      'Always state that legal information is not professional legal advice when the topic has real-world legal consequences.',
      'Ask for jurisdiction when it matters.'
    ].join(' '),
  },
  {
    id: 'medical-education-assistant',
    name: 'Medical Education Assistant',
    category: 'Medical',
    icon: Stethoscope,
    description: 'Medical education summaries and terminology. Not diagnosis or treatment.',
    traits: ['safe', 'educational', 'cautious'],
    recommendedModels: ['MedGemma', 'BioMistral', 'Gemini Flash'],
    prompt: [
      'You are a medical education assistant, not a doctor.',
      'Explain medical concepts for study and understanding.',
      'Do not diagnose, prescribe, or replace professional medical advice.',
      'For symptoms or urgent situations, advise the user to consult a qualified medical professional.'
    ].join(' '),
  },
  {
    id: 'writing-polisher',
    name: 'Writing Polisher',
    category: 'Writing',
    icon: PenLine,
    description: 'Rewrite, polish, summarize, formalize, and improve tone.',
    traits: ['clear', 'polished', 'tone-aware'],
    recommendedModels: ['Mistral 7B Instruct', 'Llama 3 8B', 'Gemini Flash'],
    prompt: [
      'You are an expert writing editor.',
      'Improve clarity, grammar, flow, and tone while preserving the user’s meaning.',
      'When asked to rewrite, provide a polished final version first, then optional notes if useful.'
    ].join(' '),
  },
  {
    id: 'research-analyst',
    name: 'Research Analyst',
    category: 'Research',
    icon: Search,
    description: 'Analyze documents, compare information, extract key points, and build reports.',
    traits: ['analytical', 'evidence-focused', 'structured'],
    recommendedModels: ['Qwen 72B', 'Llama 70B', 'Mistral 7B', 'Gemini Flash'],
    prompt: [
      'You are a careful research analyst.',
      'Use provided documents and attachments as primary context.',
      'Separate facts, assumptions, and recommendations.',
      'When information is missing, say exactly what is missing instead of guessing.'
    ].join(' '),
  },
  {
    id: 'product-security-reviewer',
    name: 'Product Security Reviewer',
    category: 'Security',
    icon: ShieldCheck,
    description: 'Reviews app flows for reliability, privacy, error handling, and deployment readiness.',
    traits: ['defensive', 'quality-focused', 'privacy-aware'],
    recommendedModels: ['Qwen2.5 Coder', 'DeepSeek Chat', 'Mistral 7B'],
    prompt: [
      'You are a product security and reliability reviewer.',
      'Look for broken flows, privacy risks, unclear errors, missing validation, and deployment weaknesses.',
      'Give practical fixes in priority order. Do not suggest unsafe behavior.'
    ].join(' '),
  },
  {
    id: 'creative-image-director',
    name: 'Creative Image Director',
    category: 'Image',
    icon: Wand2,
    description: 'Prompt engineer for image generation, thumbnails, posters, and product visuals.',
    traits: ['visual', 'creative', 'prompt-focused'],
    recommendedModels: ['Pollinations FLUX', 'SDXL', 'FLUX Schnell', 'Stability Image Core'],
    prompt: [
      'You are a creative director and image prompt engineer.',
      'Turn rough ideas into detailed image prompts with style, lighting, composition, mood, and negative prompts.',
      'For product or marketing visuals, make prompts clean, professional, and brand-safe.'
    ].join(' '),
  },
];

function traitsJson(traits: string[]): string {
  try { return JSON.stringify(traits); } catch { return '[]'; }
}

function charIconFor(name: string) {
  const preset = COMMON_CHARACTER_PRESETS.find(p => p.name === name);
  return preset?.icon || User;
}

export default function CharacterEditor() {
  const store = useAppStore();
  const { characters, setCharacters, activeCharacterId, setActiveCharacter, currentModel } = store;
  const [selectedChar, setSelectedChar] = useState<Character | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [filter, setFilter] = useState('all');
  const [notice, setNotice] = useState<string>('');
  const [busyPresetId, setBusyPresetId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', description: '', system_prompt: '', traits: '[]' });

  const existingNames = useMemo(() => new Set(characters.map(c => c.name.trim().toLowerCase())), [characters]);
  const categories = useMemo(() => ['all', ...Array.from(new Set(COMMON_CHARACTER_PRESETS.map(p => p.category)))], []);
  const visiblePresets = useMemo(() => COMMON_CHARACTER_PRESETS.filter(p => filter === 'all' || p.category === filter), [filter]);

  const refreshCharacters = async () => {
    const chars = await invoke<Character[]>('get_characters');
    setCharacters(chars);
    return chars;
  };

  const createCharacterFromData = async (data: { name: string; description: string; prompt: string; traits: string[] }) => {
    const id = await invoke<string>('create_character', {
      name: data.name,
      description: data.description,
      systemPrompt: data.prompt,
      avatarPath: null,
      traits: traitsJson(data.traits),
      folderId: null
    });
    return id;
  };

  const handleCreate = async () => {
    if (!form.name.trim() || !form.system_prompt.trim()) {
      setNotice('Character name and system prompt are required.');
      return;
    }
    try {
      const id = await invoke<string>('create_character', {
        name: form.name.trim(),
        description: form.description.trim(),
        systemPrompt: form.system_prompt.trim(),
        avatarPath: null,
        traits: form.traits || '[]',
        folderId: null
      });
      const chars = await refreshCharacters();
      setActiveCharacter(id);
      setSelectedChar(chars.find(c => c.id === id) || null);
      setIsCreating(false);
      setForm({ name: '', description: '', system_prompt: '', traits: '[]' });
      setNotice('Character saved and selected for chat.');
    } catch (err) {
      setNotice(`Failed to create character: ${String(err)}`);
    }
  };

  const handleCreatePreset = async (preset: CharacterPreset, useAfterCreate = true) => {
    setBusyPresetId(preset.id);
    try {
      let char = characters.find(c => c.name.trim().toLowerCase() === preset.name.trim().toLowerCase());
      if (!char) {
        const id = await createCharacterFromData({ name: preset.name, description: preset.description, prompt: preset.prompt, traits: preset.traits });
        const chars = await refreshCharacters();
        char = chars.find(c => c.id === id) || chars.find(c => c.name === preset.name);
      }
      if (char && useAfterCreate) {
        setSelectedChar(char);
        setActiveCharacter(char.id);
        setNotice(`${char.name} is now active. Open Chat or start a new chat to use it.`);
      } else {
        setNotice(`${preset.name} was added to your character library.`);
      }
    } catch (err) {
      setNotice(`Failed to add preset: ${String(err)}`);
    } finally {
      setBusyPresetId(null);
    }
  };

  const handleAddAllPresets = async () => {
    setBusyPresetId('all');
    let added = 0;
    try {
      for (const preset of COMMON_CHARACTER_PRESETS) {
        if (existingNames.has(preset.name.trim().toLowerCase())) continue;
        await createCharacterFromData({ name: preset.name, description: preset.description, prompt: preset.prompt, traits: preset.traits });
        added += 1;
      }
      await refreshCharacters();
      setNotice(added ? `Added ${added} professional character preset(s).` : 'All common character presets already exist.');
    } catch (err) {
      setNotice(`Failed while adding presets: ${String(err)}`);
    } finally {
      setBusyPresetId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this character? Existing chats will remain, but this persona will be removed.')) return;
    await invoke('delete_character', { id });
    const chars = await refreshCharacters();
    if (selectedChar?.id === id) setSelectedChar(null);
    if (activeCharacterId === id) setActiveCharacter(null);
    setNotice(chars.length ? 'Character deleted.' : 'Character deleted. Add a preset to get started.');
  };

  const useCharacter = (char: Character) => {
    setSelectedChar(char);
    setActiveCharacter(char.id);
    setNotice(`${char.name} is active for new messages. Existing chats can use it immediately unless they were started with a different saved character.`);
  };

  const startChatWithCharacter = async (char: Character) => {
    setActiveCharacter(char.id);
    const id = await invoke<string>('create_conversation', {
      title: char.name,
      characterId: char.id,
      modelId: currentModel || null,
      mode: 'chat'
    });
    store.setActiveConversation(id);
    store.setMessages(id, [] as Message[]);
    const convs = await invoke<Conversation[]>('get_conversations');
    store.setConversations(convs);
    store.setActiveView('chat');
  };

  const fillFromPreset = (preset: CharacterPreset) => {
    setIsCreating(true);
    setForm({ name: preset.name, description: preset.description, system_prompt: preset.prompt, traits: traitsJson(preset.traits) });
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 bg-[radial-gradient(circle_at_top_right,rgba(14,165,233,0.12),transparent_28%),radial-gradient(circle_at_bottom_left,rgba(168,85,247,0.10),transparent_32%)]">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black tracking-tight mb-1">Characters</h1>
            <p className="text-surface-500 max-w-2xl">Create, select, and start chats with specialized personas. Characters now actually drive the chat system prompt.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={handleAddAllPresets} disabled={busyPresetId === 'all'} className="btn-secondary flex items-center gap-2">
              <CopyPlus className="w-4 h-4" /> {busyPresetId === 'all' ? 'Adding...' : 'Add all common characters'}
            </button>
            <button onClick={() => setIsCreating(true)} className="btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" /> New Character
            </button>
          </div>
        </div>

        {notice && <div className="rounded-2xl border border-primary-400/30 bg-primary-500/10 p-3 text-sm text-primary-700 dark:text-primary-300">{notice}</div>}

        <section className="glass-panel rounded-3xl p-5 border border-white/10">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
            <div>
              <h2 className="text-xl font-bold flex items-center gap-2"><Star className="w-5 h-5 text-primary-500" /> Common character presets</h2>
              <p className="text-sm text-surface-500">One-click personas for the most common real-world use cases.</p>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {categories.map(cat => (
                <button key={cat} onClick={() => setFilter(cat)} className={`px-3 py-1.5 rounded-xl text-sm font-semibold whitespace-nowrap ${filter === cat ? 'bg-primary-600 text-white' : 'bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-300 hover:bg-surface-200 dark:hover:bg-surface-700'}`}>
                  {cat === 'all' ? 'All' : cat}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {visiblePresets.map(preset => {
              const exists = existingNames.has(preset.name.trim().toLowerCase());
              const Icon = preset.icon;
              return (
                <div key={preset.id} className="rounded-2xl border border-surface-200 dark:border-surface-800 bg-white/60 dark:bg-surface-950/50 p-4 flex flex-col min-w-0">
                  <div className="flex items-start gap-3">
                    <div className="w-11 h-11 rounded-2xl bg-primary-500/10 text-primary-500 flex items-center justify-center shrink-0"><Icon className="w-5 h-5" /></div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <h3 className="font-bold truncate">{preset.name}</h3>
                        {exists && <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />}
                      </div>
                      <p className="text-xs text-surface-500">{preset.category}</p>
                    </div>
                  </div>
                  <p className="text-sm text-surface-600 dark:text-surface-400 mt-3 leading-relaxed flex-1">{preset.description}</p>
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {preset.traits.slice(0, 4).map(t => <span key={t} className="text-[10px] px-2 py-1 rounded-full bg-surface-100 dark:bg-surface-800 text-surface-500">{t}</span>)}
                  </div>
                  <p className="text-xs text-surface-500 mt-3 line-clamp-2">Recommended: {preset.recommendedModels.join(', ')}</p>
                  <div className="flex flex-wrap gap-2 mt-4">
                    <button onClick={() => handleCreatePreset(preset, true)} disabled={busyPresetId === preset.id} className="btn-primary text-sm flex-1 min-w-[7rem]">
                      {exists ? 'Use' : busyPresetId === preset.id ? 'Adding...' : 'Add & Use'}
                    </button>
                    <button onClick={() => fillFromPreset(preset)} className="btn-secondary text-sm">Customize</button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <div className="grid grid-cols-1 xl:grid-cols-[22rem,1fr] gap-6">
          <div className="glass-panel rounded-3xl p-4 border border-surface-200 dark:border-surface-800 min-w-0">
            <h2 className="font-bold mb-3">Your character library</h2>
            <div className="space-y-2 max-h-[32rem] overflow-y-auto pr-1">
              {characters.length === 0 && <div className="rounded-2xl border border-dashed border-surface-300 dark:border-surface-700 p-4 text-sm text-surface-500 text-center">No saved characters yet. Add a common preset above.</div>}
              {characters.map(char => {
                const Icon = charIconFor(char.name);
                const active = activeCharacterId === char.id;
                return (
                  <button
                    key={char.id}
                    onClick={() => { setSelectedChar(char); }}
                    className={`w-full text-left p-4 rounded-2xl border transition-all min-w-0 ${selectedChar?.id === char.id ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20' : active ? 'border-green-500/60 bg-green-500/10' : 'border-surface-200 dark:border-surface-800 hover:border-surface-300 dark:hover:border-surface-700'}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-2xl bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center shrink-0">
                        <Icon className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold truncate">{char.name}</p>
                        <p className="text-xs text-surface-500 truncate">{active ? 'Active character' : char.description}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-w-0">
            {isCreating ? (
              <div className="glass-panel rounded-3xl p-6 space-y-4 border border-surface-200 dark:border-surface-800">
                <h3 className="font-bold text-xl">Create Character</h3>
                <div className="grid gap-4">
                  <label className="text-sm font-medium">Name<input value={form.name} onChange={e => setForm({...form, name: e.target.value})} className="input-field mt-1" placeholder="e.g., Startup Strategy Advisor" /></label>
                  <label className="text-sm font-medium">Description<input value={form.description} onChange={e => setForm({...form, description: e.target.value})} className="input-field mt-1" placeholder="Brief professional description" /></label>
                  <label className="text-sm font-medium">System Prompt<textarea value={form.system_prompt} onChange={e => setForm({...form, system_prompt: e.target.value})} className="input-field mt-1 min-h-[180px] resize-y" placeholder="Define the character's role, tone, boundaries, and response style" /></label>
                </div>
                <div className="flex flex-wrap gap-2 pt-2">
                  <button onClick={handleCreate} className="btn-primary flex items-center gap-2"><Save className="w-4 h-4" />Save & Use</button>
                  <button onClick={() => setIsCreating(false)} className="btn-secondary">Cancel</button>
                </div>
              </div>
            ) : selectedChar ? (
              <div className="glass-panel rounded-3xl p-6 space-y-5 border border-surface-200 dark:border-surface-800">
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-14 h-14 rounded-2xl bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center shrink-0">
                      {(() => { const Icon = charIconFor(selectedChar.name); return <Icon className="w-7 h-7 text-primary-600 dark:text-primary-400" />; })()}
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-bold text-xl truncate">{selectedChar.name}</h3>
                      <p className="text-sm text-surface-500">{selectedChar.description}</p>
                      {activeCharacterId === selectedChar.id && <p className="text-xs text-green-500 font-semibold mt-1">Active for chat</p>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    <button onClick={() => useCharacter(selectedChar)} className="btn-primary flex items-center gap-2"><CheckCircle2 className="w-4 h-4" />Use Character</button>
                    <button onClick={() => startChatWithCharacter(selectedChar)} className="btn-secondary flex items-center gap-2"><MessageSquarePlus className="w-4 h-4" />New Chat</button>
                    <button onClick={() => handleDelete(selectedChar.id)} className="p-2 rounded-xl hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 transition-colors" title="Delete character"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2">System Prompt</label>
                  <div className="p-4 rounded-2xl bg-surface-50 dark:bg-surface-900 border border-surface-200 dark:border-surface-800 max-h-[28rem] overflow-y-auto">
                    <p className="text-sm whitespace-pre-wrap leading-relaxed">{selectedChar.system_prompt}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-4 text-sm text-surface-500">
                  <span className="flex items-center gap-1"><BookOpen className="w-4 h-4" />Memory-ready persona</span>
                  <span>Use this character from the button above, then open Chat.</span>
                </div>
              </div>
            ) : (
              <div className="glass-panel rounded-3xl p-10 text-center text-surface-500 border border-surface-200 dark:border-surface-800">Select a saved character, add a preset, or create a custom persona.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
