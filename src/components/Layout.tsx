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
import EnterpriseServer from './EnterpriseServer';
import SocWorkspace from './SocWorkspace';
import KnowledgeChatWorkspace from './knowledgeChat/KnowledgeChatWorkspace';

export default function Layout() {
  const activeView = useAppStore(s => s.activeView);
  const sidebarOpen = useAppStore(s => s.sidebarOpen);
  const setupCompleted = useAppStore(s => s.setupCompleted);
  const theme = useAppStore(s => s.theme);
  const setActiveView = useAppStore(s => s.setActiveView);
  const [hydrated, setHydrated] = useState(() => useAppStore.persist.hasHydrated());

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
    if (!setupCompleted && activeView === 'chat') {
      setActiveView('setup');
    }
  }, [hydrated, setupCompleted, activeView, setActiveView]);

  // #region agent log
  useEffect(() => {
    const root = document.documentElement;
    const bodyCs = getComputedStyle(document.body);
    const layout = document.querySelector('.app-gradient-bg');
    const layoutCs = layout ? getComputedStyle(layout) : null;
    const rootEl = document.getElementById('root');
    fetch('http://127.0.0.1:7414/ingest/28bf2132-0f52-40ef-96b9-4e681c1d7653', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '7d5a77' },
      body: JSON.stringify({
        sessionId: '7d5a77',
        runId: 'white-ui-2',
        hypothesisId: 'H4',
        location: 'Layout.tsx:mount',
        message: 'layout_visible_theme_state',
        data: {
          theme,
          activeView,
          setupCompleted,
          hydrated,
          htmlHasDark: root.classList.contains('dark'),
          bodyBg: bodyCs.backgroundColor,
          layoutBg: layoutCs ? layoutCs.backgroundColor : null,
          rootHasChildren: !!rootEl && rootEl.childElementCount > 0,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => undefined);
  }, [theme, activeView, setupCompleted, hydrated]);
  // #endregion

  return (
    <div className="relative flex h-screen w-screen overflow-hidden app-gradient-bg text-surface-950 dark:text-surface-50">
      <Sidebar />
      <main className={`relative z-10 min-w-0 flex-1 flex flex-col transition-[margin] duration-300 ${sidebarOpen ? 'md:ml-72' : 'ml-0'}`}>
        {activeView === 'home' && <HomeDashboard />}
        {activeView === 'setup' && <SetupWizard />}
        {activeView === 'chat' && <ChatView />}
        {activeView === 'soc' && <SocWorkspace />}
        {activeView === 'knowledge-chat' && <KnowledgeChatWorkspace />}
        {activeView === 'hardware' && <HardwareMonitor />}
        {activeView === 'runtime' && <RuntimeManager />}
        {activeView === 'models' && <ModelManager />}
        {activeView === 'enterprise-server' && <EnterpriseServer />}
        {activeView === 'image-studio' && <ImageStudio />}
        {activeView === 'diagnostics' && <DiagnosticsPanel />}
        {activeView === 'characters' && <CharacterEditor />}
        {activeView === 'settings' && <SettingsPanel />}
        {activeView === 'prompts' && <PromptLibrary />}
        {activeView === 'storage' && <StorageManager />}
        {activeView === 'backup' && <BackupRestore />}
        {activeView === 'help' && <HelpCenter />}
      </main>
    </div>
  );
}
