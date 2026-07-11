import { useState } from 'react';
import {
  Check, ClipboardCopy, Copy, PlayCircle, Send
} from 'lucide-react';
import { useAppStore } from '../store';
import { useKnowledgeChatStore } from '../knowledgeChat/store';
import SocExportButton from './SocExportButton';
import { buildSocPrompt } from '../socPromptTemplates';
import { SOC_SYSTEM_PROMPT } from '../socChatHandoff';
import {
  buildSocAutoKnowledgeContextBlock,
  buildSocRetrievalQuery,
  retrieveSocGroundedKnowledge,
} from '../socKnowledgeRetrieval';
import {
  buildSocDemoSampleSummary,
  buildSocDemoValidatorSampleText,
  SOC_DEMO_SAMPLES,
  type SocDemoSample,
} from '../socDemoSamples';

interface SocExamplesPanelProps {
  onApplySample: (sample: SocDemoSample) => void;
}

export default function SocExamplesPanel({ onApplySample }: SocExamplesPanelProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const {
    socKnowledgeCollectionId,
    setPendingChatPrompt,
    setActiveView,
    setSidebarOpen,
    currentModel,
  } = useAppStore();
  const { embeddingModelPath, retrievalMode, topK } = useKnowledgeChatStore();

  const copyText = async (id: string, text: string, message: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setNotice(message);
    window.setTimeout(() => setCopiedId(null), 1800);
  };

  const copySample = (sample: SocDemoSample) => {
    copyText(sample.id, buildSocDemoSampleSummary(sample), 'Example copied to clipboard.');
  };

  const openSampleInChat = async (sample: SocDemoSample) => {
    if (!currentModel) {
      setNotice('Choose a model under Models before using Chat.');
      return;
    }

    let knowledgeContext = '';
    if (socKnowledgeCollectionId) {
      try {
        const query = buildSocRetrievalQuery(sample.recommendedAction, sample.input);
        const retrieval = await retrieveSocGroundedKnowledge({
          collectionId: socKnowledgeCollectionId,
          query,
          embeddingModelPath,
          retrievalMode,
          topK,
        });
        knowledgeContext = buildSocAutoKnowledgeContextBlock(retrieval);
      } catch {
        knowledgeContext = '';
      }
    }

    const compactPrompt = buildSocPrompt(sample.recommendedAction, sample.input, knowledgeContext);
    setPendingChatPrompt(compactPrompt, { soc: true, autoSend: true });
    setActiveView('chat');
    setSidebarOpen(false);
    setNotice(knowledgeContext
      ? 'Example sent to Chat with matching company documents.'
      : 'Example sent to Chat.');
  };

  const copyValidatorSamples = () => {
    copyText('validator-samples', buildSocDemoValidatorSampleText(), 'Validator test files copied. Paste into Validators below.');
  };

  const openValidatorSamplesInChat = () => {
    if (!currentModel) {
      setNotice('Choose a model under Models before using Chat.');
      return;
    }
    setPendingChatPrompt([
      SOC_SYSTEM_PROMPT,
      '',
      'Explain how to use the built-in validator test files: parser XML, playbook JSON, regex, sample logs, and IOC text.',
      'Keep it short. Remind the analyst that validators run locally and do not connect to FortiSIEM or FortiSOAR.',
    ].join('\n'), { soc: true, autoSend: true });
    setActiveView('chat');
    setSidebarOpen(false);
    setNotice('Validator guide sent to Chat.');
  };

  return (
    <section className="panel-shell p-4 sm:p-6 space-y-5">
      <div>
        <h2 className="text-xl font-black text-surface-950 dark:text-white">Practice scenarios</h2>
        <p className="mt-1 text-sm text-surface-600 dark:text-surface-300">
          Synthetic examples to try triage, validators, and reports. Not real customer data.
        </p>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {SOC_DEMO_SAMPLES.map(sample => (
          <div key={sample.id} className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4 space-y-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">{sample.category}</p>
              <h3 className="mt-1 font-black text-surface-950 dark:text-white">{sample.title}</h3>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 gap-2">
              <button type="button" onClick={() => onApplySample(sample)} className="btn-primary flex items-center justify-center gap-2 text-sm">
                <PlayCircle className="w-4 h-4" /> Load into form
              </button>
              <button type="button" onClick={() => openSampleInChat(sample)} className="btn-secondary flex items-center justify-center gap-2 text-sm">
                <Send className="w-4 h-4" /> Open in Chat
              </button>
              <button type="button" onClick={() => copySample(sample)} className="btn-secondary flex items-center justify-center gap-2 text-sm sm:col-span-2 lg:col-span-1 xl:col-span-2">
                {copiedId === sample.id ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copiedId === sample.id ? 'Copied' : 'Copy'}
              </button>
              <SocExportButton
                label="Export"
                defaultFileName={`nexus-soc-example-${sample.id}.md`}
                contents={buildSocDemoSampleSummary(sample)}
                kind="md"
                className="btn-secondary text-sm sm:col-span-2 lg:col-span-1 xl:col-span-2"
                onStatus={(message) => setNotice(message)}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4">
        <h3 className="font-black text-surface-950 dark:text-white mb-1">Validator test files</h3>
        <p className="text-sm text-surface-600 dark:text-surface-300 mb-3">
          Sample parser, playbook, regex, and log text for the Validators section.
        </p>
        <div className="flex flex-col sm:flex-row flex-wrap gap-2">
          <button type="button" onClick={copyValidatorSamples} className="btn-secondary flex items-center justify-center gap-2 text-sm">
            {copiedId === 'validator-samples' ? <Check className="w-4 h-4" /> : <ClipboardCopy className="w-4 h-4" />}
            {copiedId === 'validator-samples' ? 'Copied' : 'Copy test files'}
          </button>
          <SocExportButton
            label="Export test files"
            defaultFileName="nexus-soc-validator-examples.md"
            contents={buildSocDemoValidatorSampleText()}
            kind="md"
            className="btn-secondary text-sm"
            onStatus={(message) => setNotice(message)}
          />
          <button type="button" onClick={openValidatorSamplesInChat} className="btn-primary flex items-center justify-center gap-2 text-sm">
            <Send className="w-4 h-4" /> Ask Chat how to use them
          </button>
        </div>
      </div>

      {notice && (
        <div className="rounded-2xl border border-sky-200/70 dark:border-sky-900/70 bg-sky-50/90 dark:bg-sky-950/25 px-4 py-3 text-sm text-sky-800 dark:text-sky-300">
          {notice}
        </div>
      )}
    </section>
  );
}
