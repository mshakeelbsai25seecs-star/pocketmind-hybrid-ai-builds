#!/usr/bin/env node
/**
 * Rewrite src-tauri/tauri.conf.json bundle.resources so Tauri 1 never sees an
 * empty `dir/**` glob, while still embedding llama.cpp backends when present.
 *
 * Always includes tooling markers + scripts. For each backend directory that
 * exists on disk (cpu/cuda/vulkan), lists every file as an *explicit* path.
 *
 * Important: do NOT use `resources/llama.cpp/<backend>/**` globs. Tauri 1's
 * resource walker respects .gitignore, and those binaries are gitignored, so
 * the glob matches nothing even when files exist on disk. Explicit paths are
 * included directly and still embed correctly.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const confPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const srcTauri = path.join(root, 'src-tauri');
const llamaRoot = path.join(srcTauri, 'resources', 'llama.cpp');

const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));

const resources = [
  'resources/tooling/MANIFEST.json',
  'resources/tooling/ci-keep/keep.txt',
  'resources/kc_intent_defaults.json',
  '../scripts/unlimited_ocr_worker.py',
  '../scripts/soc_pdf_ocr.py',
  '../scripts/doc_export_worker.py',
  '../scripts/doc_export',
];

for (const rel of [
  'resources/llama.cpp/README.md',
  'resources/llama.cpp/ci-keep/keep.txt',
  'resources/llama.cpp/BUNDLE_MANIFEST.txt',
]) {
  if (fs.existsSync(path.join(srcTauri, rel))) {
    resources.push(rel);
  }
}

function listFilesRecursive(absDir) {
  const out = [];
  for (const name of fs.readdirSync(absDir)) {
    const abs = path.join(absDir, name);
    if (fs.statSync(abs).isDirectory()) {
      out.push(...listFilesRecursive(abs));
    } else {
      out.push(abs);
    }
  }
  return out;
}

for (const backend of ['cpu', 'cuda', 'vulkan']) {
  const dir = path.join(llamaRoot, backend);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;

  let files = listFilesRecursive(dir);
  if (files.length === 0) {
    const keep = path.join(dir, 'ci-keep.txt');
    fs.writeFileSync(keep, 'keep\n');
    files = [keep];
  }

  for (const abs of files) {
    const rel = path.relative(srcTauri, abs).split(path.sep).join('/');
    resources.push(rel);
  }
  console.log(`  backend ${backend}: ${files.length} file(s)`);
}

// Verify every path exists (no globs expected after rewrite).
for (const r of resources) {
  if (r.includes('*')) {
    throw new Error(`Unexpected glob in bundle.resources (use explicit paths): ${r}`);
  }
  const abs = path.join(srcTauri, r);
  if (!fs.existsSync(abs)) throw new Error(`Missing resource: ${r}`);
}

conf.tauri.bundle.resources = resources;
fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
console.log('Updated tauri bundle.resources:');
for (const r of resources) console.log(' ', r);
