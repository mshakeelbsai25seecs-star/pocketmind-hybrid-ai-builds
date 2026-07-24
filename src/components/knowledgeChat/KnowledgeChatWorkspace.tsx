import CollectionPanel from './CollectionPanel';
import KnowledgeChatPanel from './KnowledgeChatPanel';
import ContextBudgetBar from '../ContextBudgetBar';
import { FEATURE_FLAGS } from '../../featureFlags';
import { computeContextBudget, defaultKeepLastN } from '../../contextBudget';
import { useAppStore } from '../../store';
import { useMemo } from 'react';

export default function KnowledgeChatWorkspace() {
  const defaultParams = useAppStore(s => s.defaultParams);
  const budget = useMemo(() => {
    if (!FEATURE_FLAGS.contextBudgetBar) return null;
    return computeContextBudget({
      systemPrompt: 'Knowledge Chat RAG context',
      messages: [],
      ragBundle: '(retrieval bundle at send time)',
      contextSize: defaultParams.context_size,
      keepLastN: defaultKeepLastN(),
    });
  }, [defaultParams.context_size]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-surface-200/80 dark:border-surface-800 px-4 sm:px-6 lg:px-8 py-4 sm:py-5">
        <div className="panel-shell p-4 sm:p-5 space-y-3">
          <div>
            <h1 className="text-2xl font-black text-surface-950 dark:text-white">Knowledge Chat</h1>
            <p className="mt-1 text-sm text-surface-600 dark:text-surface-300">
              Point at a local folder, build an index, then ask questions. Answers cite the files they came from.
            </p>
          </div>
          {budget && (
            <ContextBudgetBar budget={budget} keepLastN={budget.keepLastN} showSlider={false} />
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
