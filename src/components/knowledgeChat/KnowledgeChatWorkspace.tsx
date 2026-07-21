import CollectionPanel from './CollectionPanel';
import KnowledgeChatPanel from './KnowledgeChatPanel';

export default function KnowledgeChatWorkspace() {
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
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 sm:px-6 lg:px-8 py-4 sm:py-5 space-y-5">
        <CollectionPanel />
        <KnowledgeChatPanel />
      </div>
    </div>
  );
}
