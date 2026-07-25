import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { appWindow } from '@tauri-apps/api/window';
import { useAppStore } from './store';
import {
  applyDeploymentToAppState,
  ensureDeploymentDirectories,
  loadDeploymentConfigMapped,
} from './deploymentConfig';
import { loadProductConfig } from './productConfig';
import { useKnowledgeChatStore } from './knowledgeChat/store';
import Layout from './components/Layout';
import { SystemInfo, ModelRecommendation, Conversation, Character, Message, LocalModelRecord } from './types';

function App() {
  const theme = useAppStore(s => s.theme);
  const performanceMode = useAppStore(s => s.performanceMode);
  const setSystemInfo = useAppStore(s => s.setSystemInfo);
  const setRecommendations = useAppStore(s => s.setRecommendations);
  const setConversations = useAppStore(s => s.setConversations);
  const setCharacters = useAppStore(s => s.setCharacters);
  const setLocalModels = useAppStore(s => s.setLocalModels);
  const setMessages = useAppStore(s => s.setMessages);
  const setActiveConversation = useAppStore(s => s.setActiveConversation);

  const setDeploymentConfig = useAppStore(s => s.setDeploymentConfig);
  const setProductConfig = useAppStore(s => s.setProductConfig);
  const setModelsDir = useAppStore(s => s.setModelsDir);
  const setSocKnowledgeCollectionRoot = useAppStore(s => s.setSocKnowledgeCollectionRoot);
  const setDefaultParams = useAppStore(s => s.setDefaultParams);
  const setSocDenseEmbeddingSettings = useAppStore(s => s.setSocDenseEmbeddingSettings);

  useEffect(() => {
    appWindow.maximize().catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await loadDeploymentConfigMapped();
        if (cancelled) return;
        await ensureDeploymentDirectories();
        if (cancelled) return;
        const kc = useKnowledgeChatStore.getState();
        applyDeploymentToAppState(config, {
          setModelsDir,
          setSocKnowledgeCollectionRoot,
          setDefaultParams,
          setSocDenseEmbeddingSettings,
          setKnowledgeEmbeddingPath: kc.setEmbeddingModelPath,
          setKnowledgeTopK: kc.setTopK,
        });
        setDeploymentConfig(config);
      } catch (err) {
        console.error('Deployment config hydrate failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [setDeploymentConfig, setModelsDir, setSocKnowledgeCollectionRoot, setDefaultParams, setSocDenseEmbeddingSettings]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await loadProductConfig();
        if (!cancelled) setProductConfig(config);
      } catch (err) {
        console.error('Product config hydrate failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [setProductConfig]);

  useEffect(() => {
    const root = window.document.documentElement;
    root.dataset.perf = performanceMode;
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
    // Conductor true-black / off-white (not slate-blue #020617)
    root.style.backgroundColor = dark ? '#000000' : '#fafafa';
    document.body.style.backgroundColor = dark ? '#000000' : '#fafafa';
  }, [theme, performanceMode]);

  useEffect(() => {
    let cancelled = false;

    const loadData = async () => {
      try {
        const [info, recs, convs, chars, models] = await Promise.all([
          invoke<SystemInfo>('get_system_info'),
          invoke<ModelRecommendation[]>('get_model_recommendations'),
          invoke<Conversation[]>('get_conversations'),
          invoke<Character[]>('get_characters'),
          invoke<LocalModelRecord[]>('get_local_models'),
        ]);

        if (cancelled) return;

        setSystemInfo(info);
        setRecommendations(recs);
        setConversations(convs);
        setCharacters(chars);
        setLocalModels(models);

        const lastSession = await invoke<string | null>('get_last_session');
        if (cancelled) return;
        if (lastSession && convs.find(c => c.id === lastSession)) {
          const msgs = await invoke<Message[]>('get_messages', { conversationId: lastSession });
          if (cancelled) return;
          setMessages(lastSession, msgs);
          setActiveConversation(lastSession);
        }
      } catch (err) {
        console.error('Failed to load initial data:', err);
      }
    };

    loadData();

    return () => {
      cancelled = true;
    };
  }, [setActiveConversation, setCharacters, setConversations, setLocalModels, setMessages, setRecommendations, setSystemInfo]);

  return <Layout />;
}

export default App;
