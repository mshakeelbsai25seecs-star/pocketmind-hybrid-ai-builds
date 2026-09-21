#!/usr/bin/env node
/**
 * Rewrite src-tauri/tauri.conf.json bundle.resources so Tauri 1 never sees an
 * empty `dir/**` glob, while still embedding llama.cpp backends when present.
 *
 * Always includes tooling markers + scripts. Adds resources/llama.cpp/<backend>/**
 * for each backend directory that exists on disk (cpu/cuda/vulkan).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const confPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const llamaRoot = path.join(root, 'src-tauri', 'resources', 'llama.cpp');

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
  const abs = path.join(root, 'src-tauri', ...rel.split('/').slice(1));
  // rel is resources/... so under src-tauri
  const abs2 = path.join(root, 'src-tauri', rel.replace(/^resources\//, 'resources/'));
  if (fs.existsSync(path.join(root, 'src-tauri', rel))) {
    resources.push(rel);
  } else if (fs.existsSync(abs2)) {
    resources.push(rel);
  }
}

for (const backend of ['cpu', 'cuda', 'vulkan']) {
  const dir = path.join(llamaRoot, backend);
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    // Prefer directory entry; Tauri expands to /**. Ensure at least one nested file.
    const keep = path.join(dir, 'ci-keep.txt');
    if (!fs.existsSync(keep)) {
      // If the backend only has binaries, that's enough for /** to match.
      const files = fs.readdirSync(dir);
      if (files.length === 0) {
        fs.writeFileSync(keep, 'keep\n');
      }
    }
    resources.push(`resources/llama.cpp/${backend}/**`);
  }
}

// Verify every non-glob path exists; every glob has a match.
for (const r of resources) {
  if (r.includes('*')) {
    const base = r.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
    const abs = path.join(root, 'src-tauri', base);
    if (!fs.existsSync(abs)) {
      throw new Error(`Resource glob base missing: ${r} -> ${abs}`);
    }
    const walk = (d) => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        if (fs.statSync(p).isDirectory()) {
          if (walk(p)) return true;
        } else {
          return true;
        }
      }
      return false;
    };
    if (!walk(abs)) {
      fs.writeFileSync(path.join(abs, 'ci-keep.txt'), 'keep\n');
    }
  } else if (r.startsWith('../')) {
    const abs = path.join(root, 'src-tauri', r);
    if (!fs.existsSync(abs)) throw new Error(`Missing resource: ${r}`);
  } else {
    const abs = path.join(root, 'src-tauri', r);
    if (!fs.existsSync(abs)) throw new Error(`Missing resource: ${r}`);
  }
}

conf.tauri.bundle.resources = resources;
fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
console.log('Updated tauri bundle.resources:');
for (const r of resources) console.log(' ', r);
