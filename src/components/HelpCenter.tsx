import { HelpCircle, Cpu, FileText, Shield, Zap, AlertTriangle, MessageSquare, Download, CheckCircle2, Rocket, Flag, Mail } from 'lucide-react';
import { onOpenExternal } from '../openExternal';
import { AI_CONTENT_REPORT_EMAIL } from '../reportAiContent';

const sections = [
  {
    icon: MessageSquare,
    title: 'Quick start',
    items: [
      'Open Setup and confirm the local llama.cpp runtime is detected.',
      'Go to Models, import or download a GGUF model, then choose Use in Chat.',
      'Open Chat and start a new conversation. Use small models first for testing.',
    ],
  },
  {
    icon: Cpu,
    title: 'Performance tips',
    items: [
      'CPU-safe defaults: context 2048, batch 128, GPU layers 0.',
      'For faster responses, use TinyLlama, Phi-3 Mini, Qwen 1.5B, or a Q4 model.',
      'Only increase GPU layers when Runtime confirms that a compatible CUDA or Vulkan runtime is available.',
    ],
  },
  {
    icon: FileText,
    title: 'Attachments',
    items: [
      'Text PDFs, DOCX, TXT, CSV, JSON, and code files are extracted locally.',
      'Scanned PDFs and image understanding require OCR or vision support. PocketMind Hybrid AI will show a limitation message when text extraction is not available.',
      'Large files are summarized into prompt-safe context instead of being dumped into the visible chat.',
    ],
  },
  {
    icon: Download,
    title: 'Embeddings, reranker & OCR downloads',
    items: [
      'Setup includes a Support models step; the same list lives under Settings → Deployment.',
      'Download BGE-M3 (docs), Qwen3-Embedding-8B (code), Qwen3-Reranker-4B, and optional Unlimited-OCR weights — the app handles the downloads.',
      'Chat GGUFs are still under Models. Support models are not packaged inside the installer.',
      'Unlimited-OCR also appears under Settings → Security (probe + CUDA status). Needs NVIDIA CUDA + Python torch on this PC.',
    ],
  },
  {
    icon: FileText,
    title: 'Unlimited-OCR (optional)',
    items: [
      'High-accuracy offline OCR for scanned PDFs and images when you have an NVIDIA GPU with CUDA.',
      'Not bundled in the installer: open Settings → Security → Scanned PDFs, or Setup → Support models, then Download.',
      'Needs Python packages: torch (CUDA), transformers, pymupdf, huggingface_hub. CPU-only PCs should keep Legacy or Docling.',
      'Auto order when ready: Unlimited-OCR → Docling → Tesseract/Windows OCR. Failures fall through without blocking Chat.',
    ],
  },
  {
    icon: FileText,
    title: 'Document Studio',
    items: [
      'Create DOCX, PPTX, and PDF on this PC: your current model writes a structured outline; Python exporters write the real file.',
      'Install exporters once: pip install python-docx python-pptx reportlab',
      'Open Document Studio from the sidebar, enter a brief, pick a format, Generate outline, then Save As.',
      'In Chat, Export as… and each assistant message also offer DOCX / PPTX / PDF using the same offline pipeline. Online models only generate the outline — files always stay local.',
    ],
  },
  {
    icon: Download,
    title: 'Model downloads',
    items: [
      'Use direct .gguf download links when downloading from Hugging Face.',
      'If a download stalls, keep the partial file and retry using the same folder.',
      'Importing the same GGUF should reuse the existing library record instead of duplicating it.',
    ],
  },
  {
    icon: Shield,
    title: 'Privacy',
    items: [
      'Offline GGUF chats stay local on your device.',
      'Files are extracted locally before being sent to the local model.',
      'Online providers should use user-provided API keys and must be clearly labeled.',
    ],
  },
  {
    icon: Flag,
    title: 'Report AI-generated content',
    items: [
      'PocketMind includes live generative AI for chat, images, documents, and coding help.',
      'Use Report on any assistant answer in Chat or Knowledge Chat, or Report on Image Studio / Document Studio outputs.',
      `You can also email ${AI_CONTENT_REPORT_EMAIL}. We review reports and act on policy-violating content.`,
    ],
  },
  {
    icon: AlertTriangle,
    title: 'Troubleshooting',
    items: [
      'If chat does not respond, run Diagnostics and check that the local engine and selected model path are ready.',
      'If output repeats or appears unrelated, use Model Health Check and try a general chat model such as Mistral, Phi, or Qwen.',
      'If the local engine becomes stuck, use Diagnostics → Stop Local Engine, then open Runtime → Scan engine.',
    ],
  },
  {
    icon: FileText,
    title: 'Knowledge Chat vs PocketCode',
    items: [
      'Knowledge Chat indexes folders for grounded Q&A and read-only Codebase Explorer on any model size. Its history appears only in Knowledge Chat.',
      'PocketCode is the Cursor-like write/run agent with Agent / Ask / Plan / Debug modes (Shift+Tab cycles). Ask is read-only; Plan writes plan files only; Build switches to Agent to execute an approved plan; Debug can sandbox+edit with screenshots.',
      'PocketCode uses retrieve-then-read (symbol index + small windows) so it does not dump whole large files. Edits auto-apply with checkpoints for undo; deletes always ask first.',
      'Org server in PocketCode uses the same chat-completions path as Chat (`enterprise:` models), not Knowledge Chat Server RAG. Preflight health must pass before a run; failures offer Retry / Open Org Server / Use last local — never a silent model switch.',
      'Chat and PocketCode attachments: vision online/org models and offline VL GGUFs (with mmproj beside the model) receive images and PDF page renders. Digital PDFs/DOCX also get text extract. Text-only models get document text only; images show Unavailable.',
      'PocketCode composer +: Mode (Agent/Ask/Plan/Debug), Skills toggles (SKILL.md under .pocketcode/skills or the user skills folder, plus built-ins), and MCP server toggles. Model name opens Local / Online / Org picker. Mic uses Whisper when an OpenAI key is saved, else browser speech.',
      'Skills inject instructions into the agent prompt (no new tools). MCP is opt-in stdio servers from Settings → MCP (Connect Cursor imports/shares .cursor/mcp.json). The agent calls tools as mcp__server__tool (Cursor-style); you must Allow once / Always allow / Deny. Disabled servers never auto-start.',
      'Online models: save provider keys in Settings or Models (OpenAI GPT-5.4/5.5, Anthropic Opus 4.7/4.8, DeepSeek, Mistral, Gemini, OpenRouter, Groq, Cerebras, Together). Use the Vision filter for multimodal models. Offline catalog includes Qwen2-VL / LLaVA (+ mmproj) and stronger coder GGUFs.',
      'Chat / Knowledge Chat / PocketCode histories are isolated by mode — they do not mix in the sidebar.',
      'Sandbox uses allowlisted runners: bundled Python/Node/rg when available, plus host tools (cargo, go, npm, java, …) via argv-only execution — never a freeform system shell.',
      'Encrypted backups use a passphrase (.pmbak). Store the passphrase safely; there is no recovery backdoor.',
    ],
  },
];

export default function HelpCenter() {
  return (
    <div className="h-full overflow-y-auto p-8 space-y-8 bg-gradient-to-br from-surface-50 via-white to-primary-50/30 dark:from-surface-950 dark:via-surface-950 dark:to-primary-950/20">
      <section className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white/80 dark:bg-surface-900/80 backdrop-blur p-8 shadow-soft">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 text-sm font-semibold mb-4">
          <HelpCircle className="w-4 h-4" /> Help Center
        </div>
        <h1 className="text-4xl font-black tracking-tight">PocketMind Hybrid AI desktop guide</h1>
        <p className="text-surface-600 dark:text-surface-400 mt-2 max-w-3xl">
          A short guide for offline models, attachments, performance checks, and privacy.
        </p>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {sections.map(section => (
          <article key={section.title} className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-6 shadow-soft">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-11 h-11 rounded-2xl bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center text-primary-700 dark:text-primary-300">
                <section.icon className="w-5 h-5" />
              </div>
              <h2 className="text-xl font-bold">{section.title}</h2>
            </div>
            <ul className="space-y-3 text-sm text-surface-700 dark:text-surface-300">
              {section.items.map(item => (
                <li key={item} className="flex gap-3">
                  <Zap className="w-4 h-4 text-primary-500 mt-0.5 shrink-0" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      <section className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-6 shadow-soft">
        <div className="flex items-start gap-3">
          <Mail className="w-5 h-5 text-primary-600 dark:text-primary-400 mt-1" />
          <div className="space-y-3">
            <div>
              <h2 className="font-bold">Support &amp; report AI content</h2>
              <p className="text-sm text-surface-600 dark:text-surface-400 mt-1 max-w-3xl">
                Use in-app Report controls on AI outputs, or email support directly. We review reports of inappropriate generative AI content and take action when policies are violated.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-primary text-sm inline-flex items-center gap-2"
                onClick={onOpenExternal(`mailto:${AI_CONTENT_REPORT_EMAIL}?subject=${encodeURIComponent('[PocketMind AI] Report AI content')}`)}
              >
                <Flag className="w-4 h-4" /> Email report
              </button>
              <button
                type="button"
                className="btn-secondary text-sm inline-flex items-center gap-2"
                onClick={onOpenExternal(`mailto:${AI_CONTENT_REPORT_EMAIL}`)}
              >
                <Mail className="w-4 h-4" /> Contact support
              </button>
            </div>
            <p className="text-xs text-surface-500">{AI_CONTENT_REPORT_EMAIL}</p>
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-primary-200 dark:border-primary-900/60 bg-primary-50 dark:bg-primary-950/20 p-6">
        <div className="flex items-start gap-3">
          <Rocket className="w-5 h-5 text-primary-600 dark:text-primary-400 mt-1" />
          <div className="space-y-4">
            <div>
              <h2 className="font-bold text-primary-900 dark:text-primary-200">PocketMind parity checklist for desktop</h2>
              <p className="text-sm text-primary-800 dark:text-primary-300 mt-1">
                PocketMind Hybrid AI Desktop now follows a production-oriented feature checklist: offline chat, online providers, model categories, Image Studio, prompt library, diagnostics, storage, backup/restore, runtime recovery, and clear tester guidance.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              {[
                'Offline GGUF chat with safe defaults',
                'Online chat provider categories',
                'Free and premium image model catalog',
                'Prompt library for study, coding, business, and writing',
                'Storage manager and backup/restore',
                'Runtime diagnostics and stuck-engine recovery',
                'Attachment extraction warnings',
                'Responsive sidebar with named chat management',
                'Report inappropriate AI-generated content',
              ].map(item => (
                <div key={item} className="flex items-start gap-2 rounded-2xl bg-white/70 dark:bg-surface-900/60 p-3 border border-primary-200/60 dark:border-primary-900/40">
                  <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
