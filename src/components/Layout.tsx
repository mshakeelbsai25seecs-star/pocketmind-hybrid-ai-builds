import { useEffect, useState } from 'react';
import { useAppStore } from '../store';
import Sidebar from './Sidebar';
import ChatView from './ChatView';
import HardwareMonitor from './HardwareMonitor';
import RuntimeManager from './RuntimeManager';
import ModelManager from './ModelManager';
import CharacterEditor from './CharacterEditor';
import SettingsPanel from './SettingsPanel';
import HomeDashboard from './HomeDashboard';
import DiagnosticsPanel from './DiagnosticsPanel';
import SetupWizard from './SetupWizard';
import PromptLibrary from './PromptLibrary';
import StorageManager from './StorageManager';
import BackupRestore from './BackupRestore';
import HelpCenter from './HelpCenter';
import ImageStudio from './ImageStudio';
import DocumentStudio from './DocumentStudio';
import EnterpriseServer from './EnterpriseServer';
import SocWorkspace from './SocWorkspace';
import KnowledgeChatWorkspace from './knowledgeChat/KnowledgeChatWorkspace';
import CodeWorkspaceLayout from './codeWorkspace/CodeWorkspaceLayout';
import AgentPermissionOverlay from './codeWorkspace/AgentPermissionOverlay';
import QuickComposeOverlay from './QuickComposeOverlay';
import { useAgentSession } from './codeWorkspace/agentSession';

export default function Layout() {
  const activeView = useAppStore(s => s.activeView);
  const sidebarOpen = useAppStore(s => s.sidebarOpen);
  const setupCompleted = useAppStore(s => s.setupCompleted);
  const setActiveView = useAppStore(s => s.setActiveView);
  const [hydrated, setHydrated] = useState(() => useAppStore.persist.hasHydrated());
  const agentSnap = useAgentSession();
  // Keep PocketCode mounted while an agent turn (or permission gate) is live
  // so React unmount cannot drop the only UI that was previously blocking progress.
  const keepCodeWorkspace =
    activeView === 'code-workspace'
    || agentSnap.running
    || agentSnap.waitingFor === 'edit'
    || agentSnap.waitingFor === 'sandbox';

  useEffect(() => {
    if (useAppStore.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    return useAppStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
  }, []);

  // Wait for persisted setupCompleted before forcing Setup — otherwise a cold
  // start briefly sees setupCompleted=false and traps the user on the wizard.
  useEffect(() => {
    if (!hydrated) return;
    if (!setupCompleted && (activeView === 'chat' || activeView === 'home')) {
      setActiveView('setup');
    }
  }, [hydrated, setupCompleted, activeView, setActiveView]);

  return (
    <div className="relative flex h-screen w-screen overflow-hidden app-gradient-bg text-surface-950 dark:text-surface-50">
      <Sidebar />
      <main className={`relative z-10 min-w-0 flex-1 flex flex-col transition-[margin] duration-300 ${sidebarOpen ? 'md:ml-72' : 'ml-0'}`}>
        {activeView === 'home' && <HomeDashboard />}
        {activeView === 'setup' && <SetupWizard />}
        {activeView === 'chat' && <ChatView />}
        {activeView === 'soc' && <SocWorkspace />}
        {activeView === 'knowledge-chat' && <KnowledgeChatWorkspace />}
        {keepCodeWorkspace && (
          <div
            className={
              activeView === 'code-workspace'
                ? 'flex-1 min-h-0 flex flex-col'
                : 'hidden'
            }
          >
            <CodeWorkspaceLayout />
          </div>
        )}
        {activeView === 'hardware' && <HardwareMonitor />}
        {activeView === 'runtime' && <RuntimeManager />}
        {activeView === 'models' && <ModelManager />}
        {activeView === 'enterprise-server' && <EnterpriseServer />}
        {activeView === 'image-studio' && <ImageStudio />}
        {activeView === 'document-studio' && <DocumentStudio />}
        {activeView === 'diagnostics' && <DiagnosticsPanel />}
        {activeView === 'characters' && <CharacterEditor />}
        {activeView === 'settings' && <SettingsPanel />}
        {activeView === 'prompts' && <PromptLibrary />}
        {activeView === 'storage' && <StorageManager />}
        {activeView === 'backup' && <BackupRestore />}
        {activeView === 'help' && <HelpCenter />}
      </main>
      <AgentPermissionOverlay />
      <QuickComposeOverlay />
    </div>
  );
}
