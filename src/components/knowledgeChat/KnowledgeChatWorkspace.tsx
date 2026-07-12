import CollectionPanel from './CollectionPanel';
import KnowledgeChatPanel from './KnowledgeChatPanel';
import { QA_CORPUS_NAME, QA_SAMPLE_QUESTIONS } from '../../knowledgeChat/types';
import { useKnowledgeChatStore } from '../../knowledgeChat/store';

export default function KnowledgeChatWorkspace() {
  const activeCollection = useKnowledgeChatStore(state =>
    state.collections.find(item => item.id === state.activeCollectionId) || null,
  );

  const qaActive = activeCollection?.name === QA_CORPUS_NAME;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-surface-200/80 dark:border-surface-800 px-4 sm:px-6 lg:px-8 py-4 sm:py-5">
        <div className="panel-shell p-4 sm:p-5 space-y-3">
          <div>
            <h1 className="text-2xl font-black text-surface-950 dark:text-white">Knowledge Chat</h1>
            <p className="mt-1 text-sm text-surface-600 dark:text-surface-300">
              Index any local folder, then ask grounded questions with cited answers from your documents.
            </p>
          </div>
          {qaActive && (
            <div className="rounded-xl border border-primary-200/80 dark:border-primary-800/60 bg-primary-50/70 dark:bg-primary-950/30 px-4 py-3">
              <p className="text-sm font-semibold text-primary-900 dark:text-primary-100">
                QA test corpus selected
              </p>
              <p className="mt-1 text-xs text-primary-800/90 dark:text-primary-200/90">
                Folder: D:\NexusAI\qa-corpus. Use Scan Folder / Build Index before asking — indexing is not automatic on launch.
              </p>
              <ul className="mt-2 text-xs text-surface-700 dark:text-surface-300 list-disc pl-5 space-y-1">
                {QA_SAMPLE_QUESTIONS.map(question => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 sm:px-6 lg:px-8 py-4 sm:py-5 space-y-5">
        <CollectionPanel />
        <KnowledgeChatPanel />
      </div>
    </div>
  );
}
