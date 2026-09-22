import { useEffect, useState } from 'react';
import { useAppStore } from '../store';
import Sidebar from './Sidebar';
import ChatView from './ChatView';
import ModelManager from './ModelManager';
import CharacterStudio from './CharacterStudio';
import SettingsPanel from './SettingsPanel';
import HomeDashboard from './HomeDashboard';
import SetupWizard from './SetupWizard';
import PromptLibrary from './PromptLibrary';
import StorageManager from './StorageManager';
import HelpCenter from './HelpCenter';
import ImageStudio from './ImageStudio';
import DocumentStudio from './DocumentStudio';
import SocCopilot from './SocCopilot';
import CodeWorkspaceLayout from './codeWorkspace/CodeWorkspaceLayout';
import HardwareRuntimeManager from './HardwareRuntimeManager';
import ControlCenter, { tabForView } from './ControlCenter';
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

  useEffect(() => {
    if (activeView === 'knowledge-chat') setActiveView('chat');
  }, [activeView, setActiveView]);

  return (
    <div className="relative flex h-screen w-screen overflow-hidden app-gradient-bg text-surface-950 dark:text-surface-50">
      <Sidebar />
      <main className={`relative z-10 min-w-0 flex-1 flex flex-col transition-[margin] duration-300 ${sidebarOpen ? 'md:ml-72' : 'ml-0'}`}>
        {activeView === 'home' && <HomeDashboard />}
        {activeView === 'setup' && <SetupWizard />}
        {activeView === 'chat' && <ChatView />}
        {activeView === 'soc' && <SocCopilot />}
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
        {(activeView === 'hardware' || activeView === 'runtime' || activeView === 'hardware-runtime') && <HardwareRuntimeManager />}
        {activeView === 'models' && <ModelManager />}
        {(activeView === 'control-center' || activeView === 'enterprise-server' || activeView === 'diagnostics' || activeView === 'backup') && (
          <ControlCenter initialTab={tabForView(activeView)} />
        )}
        {activeView === 'image-studio' && <ImageStudio />}
        {activeView === 'document-studio' && <DocumentStudio />}
        {activeView === 'characters' && <CharacterStudio />}
        {activeView === 'settings' && <SettingsPanel />}
        {activeView === 'prompts' && <PromptLibrary />}
        {activeView === 'storage' && <StorageManager />}
        {activeView === 'help' && <HelpCenter />}
      </main>
      <AgentPermissionOverlay />
      <QuickComposeOverlay />
    </div>
  );
}
