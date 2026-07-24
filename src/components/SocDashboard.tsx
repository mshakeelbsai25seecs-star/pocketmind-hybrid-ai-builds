import { useMemo } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  BarChart3, BookOpen, Database, FileCheck2, FileText, Layers, Lock, Route, Search, ShieldCheck,
} from 'lucide-react';
import { useAppStore } from '../store';
import { flattenSocChunks, getSocRagHealthStats } from '../socKnowledgeIndex';

interface StatusCardProps {
  label: string;
  value: string | number;
  icon: LucideIcon;
  tone?: 'sky' | 'emerald' | 'amber' | 'indigo';
}

function toneClasses(tone: StatusCardProps['tone'] = 'sky'): string {
  switch (tone) {
    case 'emerald':
      return 'border-emerald-200/80 dark:border-emerald-900/70 bg-emerald-50/80 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-300';
    case 'amber':
      return 'border-amber-200/80 dark:border-amber-900/70 bg-amber-50/80 dark:bg-amber-950/20 text-amber-700 dark:text-amber-300';
    case 'indigo':
      return 'border-indigo-200/80 dark:border-indigo-900/70 bg-indigo-50/80 dark:bg-indigo-950/20 text-indigo-700 dark:text-indigo-300';
    default:
      return 'border-primary-200/80 dark:border-primary-900/70 bg-primary-50/80 dark:bg-primary-950/20 text-primary-700 dark:text-primary-300';
  }
}

function StatusCard({ label, value, icon: Icon, tone }: StatusCardProps) {
  return (
    <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-white/72 dark:bg-surface-900/50 p-4 shadow-lg shadow-surface-900/5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500 dark:text-surface-400">{label}</p>
          <p className="mt-2 text-2xl font-black tracking-tight text-surface-950 dark:text-white">{value}</p>
        </div>
        <div className={`w-10 h-10 rounded-2xl border flex items-center justify-center ${toneClasses(tone)}`}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </div>
  );
}

export default function SocDashboard() {
  const {
    socKnowledgeResources,
    selectedSocKnowledgeResourceIds,
    selectedSocKnowledgeChunkIds,
  } = useAppStore();

  const allChunks = useMemo(() => flattenSocChunks(socKnowledgeResources), [socKnowledgeResources]);
  const ragHealth = useMemo(() => getSocRagHealthStats(socKnowledgeResources), [socKnowledgeResources]);
  const indexedResources = useMemo(
    () => socKnowledgeResources.filter(resource => resource.indexStatus === 'indexed' || resource.indexStatus === 'warning'),
    [socKnowledgeResources]
  );

  const selectedChunkCount = useMemo(() => {
    const available = new Set(allChunks.map(chunk => chunk.id));
    return selectedSocKnowledgeChunkIds.filter(id => available.has(id)).length;
  }, [allChunks, selectedSocKnowledgeChunkIds]);

  const selectedResourceCount = useMemo(() => {
    const available = new Set(socKnowledgeResources.map(resource => resource.id));
    return selectedSocKnowledgeResourceIds.filter(id => available.has(id)).length;
  }, [socKnowledgeResources, selectedSocKnowledgeResourceIds]);

  return (
    <section className="panel-shell p-4 sm:p-6 space-y-5">
      <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200/80 dark:border-emerald-900/70 bg-emerald-50/85 dark:bg-emerald-950/25 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300">
        <BarChart3 className="w-4 h-4" /> Dashboard
      </div>

      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <StatusCard label="Runs locally" value="Yes" icon={Lock} tone="emerald" />
        <StatusCard label="Registered files" value={socKnowledgeResources.length} icon={BookOpen} tone="sky" />
        <StatusCard label="Indexed files" value={indexedResources.length} icon={Database} tone="indigo" />
        <StatusCard label="Searchable sections" value={allChunks.length} icon={Layers} tone="sky" />
        <StatusCard label="Search type" value={ragHealth.denseAvailable ? 'Semantic + keyword' : 'Keyword'} icon={Route} tone="indigo" />
        <StatusCard label="Pinned references" value={selectedResourceCount} icon={FileCheck2} tone="emerald" />
        <StatusCard label="Pinned excerpts" value={selectedChunkCount} icon={Search} tone="indigo" />
        <StatusCard label="Validators" value="Ready" icon={ShieldCheck} tone="emerald" />
        <StatusCard label="Reports" value="Ready" icon={FileText} tone="amber" />
      </div>
    </section>
  );
}
