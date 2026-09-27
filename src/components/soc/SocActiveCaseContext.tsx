import { createContext, useContext, type ReactNode } from 'react';
import type { SocCase, SocCaseIndexEntry } from '../../soc/types';

export type SocNavId =
  | 'queue'
  | 'case'
  | 'import'
  | 'memory'
  | 'metrics'
  | 'knowledge'
  | 'workspace'
  | 'validators'
  | 'reports'
  | 'practice'
  | 'security'
  | 'connectors';

interface SocActiveCaseContextValue {
  nav: SocNavId;
  setNav: (nav: SocNavId) => void;
  index: SocCaseIndexEntry[];
  refreshIndex: () => Promise<void>;
  activeCase: SocCase | null;
  setActiveCaseId: (id: string | null) => void;
  reloadActiveCase: () => Promise<void>;
  saveActiveCase: (next: SocCase) => Promise<SocCase>;
  status: string | null;
  setStatus: (msg: string | null) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}

const Ctx = createContext<SocActiveCaseContextValue | null>(null);

export function SocActiveCaseProvider({
  value,
  children,
}: {
  value: SocActiveCaseContextValue;
  children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSocActiveCase(): SocActiveCaseContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSocActiveCase requires SocActiveCaseProvider');
  return ctx;
}
