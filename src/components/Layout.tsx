import { useEffect } from 'react';
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
  const setActiveView = useAppStore(s => s.setActiveView);

  useEffect(() => {
    if (!setupCompleted && activeView === 'chat') {
      setActiveView('setup');
    }
  }, [setupCompleted, activeView, setActiveView]);
  
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
