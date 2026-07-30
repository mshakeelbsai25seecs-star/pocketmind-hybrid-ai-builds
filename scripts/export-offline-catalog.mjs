import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFLINE_CHAT_CATALOG } from '../src/modelCatalog.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'enterprise-server', 'llama-cpp', 'admin', 'catalog.json');

const models = OFFLINE_CHAT_CATALOG.map((m) => ({
  id: m.id,
  name: m.name,
  params: m.params,
  quant: m.quant,
  size: m.size,
  ram: m.ram,
  categories: m.categories,
  recommendedUse: m.recommendedUse,
  url: m.url || '',
  shardUrls: m.shardUrls || [],
  mmprojUrl: m.mmprojUrl || null,
  visionCapable: !!m.visionCapable,
}));

const payload = { version: 1, source: 'offline_chat', models };
writeFileSync(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`Wrote ${out} (${models.length} models)`);
