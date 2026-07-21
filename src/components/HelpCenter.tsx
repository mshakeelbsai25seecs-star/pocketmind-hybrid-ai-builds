import { HelpCircle, Cpu, FileText, Image, Shield, Zap, AlertTriangle, MessageSquare, Download, CheckCircle2, Rocket } from 'lucide-react';

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
    icon: AlertTriangle,
    title: 'Troubleshooting',
    items: [
      'If chat does not respond, run Diagnostics and check that the local engine and selected model path are ready.',
      'If output repeats or appears unrelated, use Model Health Check and try a general chat model such as Mistral, Phi, or Qwen.',
      'If the local engine becomes stuck, use Diagnostics → Stop Local Engine, then open Runtime → Scan engine.',
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
                'Responsive sidebar with named chat management'
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
