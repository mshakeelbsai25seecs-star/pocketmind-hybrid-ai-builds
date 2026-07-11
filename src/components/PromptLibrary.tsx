import { useMemo, useState } from 'react';
import { BookOpen, Copy, Check, Search, Sparkles, Code2, GraduationCap, Briefcase, PenTool, Calculator, ShieldQuestion } from 'lucide-react';

interface PromptItem {
  id: string;
  title: string;
  category: string;
  icon: string;
  prompt: string;
  bestFor: string;
}

const PROMPTS: PromptItem[] = [
  {
    id: 'summarize-clean',
    title: 'Clean document summary',
    category: 'Study',
    icon: '📄',
    bestFor: 'PDFs, DOCX, lecture notes',
    prompt: 'Summarize the attached document clearly. Use headings, bullet points, key definitions, important formulas, and a short final revision checklist.',
  },
  {
    id: 'exam-teacher',
    title: 'Exam teacher mode',
    category: 'Study',
    icon: '🎓',
    bestFor: 'Learning and revision',
    prompt: 'Teach this topic like I have an exam tomorrow. Start from intuition, then formulas, then solved examples, then common mistakes, then a short cheat sheet.',
  },
  {
    id: 'code-review',
    title: 'Professional code review',
    category: 'Coding',
    icon: '💻',
    bestFor: 'Debugging and refactoring',
    prompt: 'Review this code professionally. Find bugs, security issues, performance problems, design weaknesses, and give corrected code only where needed.',
  },
  {
    id: 'debug-error',
    title: 'Debug terminal error',
    category: 'Coding',
    icon: '🛠️',
    bestFor: 'Build logs and crashes',
    prompt: 'Analyze this error step by step. Tell me the root cause, the exact file or setting likely responsible, and the safest commands or code changes to fix it without breaking unrelated parts.',
  },
  {
    id: 'math-format',
    title: 'Math solution with formatting',
    category: 'Math',
    icon: '🧮',
    bestFor: 'Matrices, calculus, linear algebra',
    prompt: 'Solve this math problem step by step. Use proper notation, matrices, equations, and clearly explain which formula is used and why.',
  },
  {
    id: 'business-email',
    title: 'Client proposal message',
    category: 'Business',
    icon: '💼',
    bestFor: 'Freelance outreach',
    prompt: 'Write a professional client proposal for this service. Make it concise, persuasive, specific to the client, and include a clear call to action.',
  },
  {
    id: 'rewrite-polish',
    title: 'Polish writing',
    category: 'Writing',
    icon: '✍️',
    bestFor: 'Reports, assignments, resumes',
    prompt: 'Rewrite this in a polished, professional, natural style. Keep the meaning, improve clarity, remove weak wording, and make it suitable for submission.',
  },
  {
    id: 'compare-options',
    title: 'Compare options',
    category: 'Reasoning',
    icon: '⚖️',
    bestFor: 'Decisions and planning',
    prompt: 'Compare these options in a table. Include pros, cons, cost/time/complexity, risks, and your final recommendation with reasoning.',
  },
];

const categoryIcons: Record<string, any> = {
  All: Sparkles,
  Study: GraduationCap,
  Coding: Code2,
  Math: Calculator,
  Business: Briefcase,
  Writing: PenTool,
  Reasoning: ShieldQuestion,
};

export default function PromptLibrary() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const categories = ['All', ...Array.from(new Set(PROMPTS.map(p => p.category)))];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PROMPTS.filter(p => {
      const categoryOk = category === 'All' || p.category === category;
      const queryOk = !q || `${p.title} ${p.category} ${p.bestFor} ${p.prompt}`.toLowerCase().includes(q);
      return categoryOk && queryOk;
    });
  }, [query, category]);

  const copyPrompt = async (item: PromptItem) => {
    await navigator.clipboard.writeText(item.prompt);
    setCopiedId(item.id);
    setTimeout(() => setCopiedId(null), 1400);
  };

  return (
    <div className="h-full overflow-y-auto p-8 space-y-8 bg-gradient-to-br from-surface-50 via-white to-primary-50/40 dark:from-surface-950 dark:via-surface-950 dark:to-primary-950/20">
      <section className="rounded-3xl border border-surface-200/70 dark:border-surface-800 bg-white/80 dark:bg-surface-900/80 backdrop-blur p-8 shadow-soft">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 text-sm font-semibold mb-4">
              <BookOpen className="w-4 h-4" /> Prompt Library
            </div>
            <h1 className="text-4xl font-black tracking-tight">Reusable expert prompts</h1>
            <p className="text-surface-600 dark:text-surface-400 mt-2 max-w-2xl">
              Fast, reliable templates for study, coding, writing, business, and reasoning. Copy a prompt, attach files if needed, and paste it into Chat.
            </p>
          </div>
          <div className="relative w-full lg:w-96">
            <Search className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-surface-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search prompts..."
              className="w-full rounded-2xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-950 pl-12 pr-4 py-3 outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
        </div>
      </section>

      <div className="flex flex-wrap gap-2">
        {categories.map(cat => {
          const Icon = categoryIcons[cat] || Sparkles;
          return (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition ${
                category === cat ? 'bg-primary-600 text-white shadow-lg shadow-primary-600/20' : 'bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-800 hover:border-primary-300'
              }`}
            >
              <Icon className="w-4 h-4" /> {cat}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {filtered.map(item => (
          <article key={item.id} className="group rounded-3xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-6 shadow-soft hover:shadow-xl transition-all">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div className="flex items-center gap-3">
                <div className="text-3xl">{item.icon}</div>
                <div>
                  <h2 className="font-bold text-lg">{item.title}</h2>
                  <p className="text-xs text-primary-600 dark:text-primary-400 font-semibold">{item.category}</p>
                </div>
              </div>
              <button
                onClick={() => copyPrompt(item)}
                className="p-2 rounded-xl bg-surface-100 dark:bg-surface-800 hover:bg-primary-100 dark:hover:bg-primary-900/40 transition"
                title="Copy prompt"
              >
                {copiedId === item.id ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-xs uppercase tracking-wide text-surface-500 mb-2">Best for: {item.bestFor}</p>
            <div className="rounded-2xl bg-surface-50 dark:bg-surface-950 border border-surface-200/70 dark:border-surface-800 p-4 text-sm leading-relaxed text-surface-700 dark:text-surface-300">
              {item.prompt}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
