/**
 * Detect how a project is tested, built and type-checked, so the agent can verify its own work
 * with the project's real commands instead of guessing (or skipping verification entirely).
 *
 * Pure parsing lives in `detectProjectCommandsFrom`; the async wrapper only supplies file text,
 * so this is testable without a workspace.
 */

import { cwReadFile } from '../api/codeWorkspace';

export interface ProjectCommand {
  kind: 'test' | 'build' | 'typecheck' | 'lint';
  argv: string[];
  /** Where the command came from, e.g. "package.json scripts.test". */
  source: string;
}

export interface ProjectFileText {
  packageJson?: string;
  cargoToml?: string;
  pyprojectToml?: string;
  goMod?: string;
  makefile?: string;
}

const PROJECT_FILES: Array<[keyof ProjectFileText, string]> = [
  ['packageJson', 'package.json'],
  ['cargoToml', 'Cargo.toml'],
  ['pyprojectToml', 'pyproject.toml'],
  ['goMod', 'go.mod'],
  ['makefile', 'Makefile'],
];

function packageManagerFor(packageJson: string): string {
  if (/"packageManager"\s*:\s*"pnpm/.test(packageJson)) return 'pnpm';
  if (/"packageManager"\s*:\s*"yarn/.test(packageJson)) return 'yarn';
  if (/"packageManager"\s*:\s*"bun/.test(packageJson)) return 'bun';
  return 'npm';
}

function npmRunArgv(manager: string, script: string): string[] {
  if (manager === 'npm') return ['npm', 'run', script];
  return [manager, 'run', script];
}

/** read_file adds a header line and may append a truncation note — both break JSON.parse. */
export function stripReadArtifacts(text: string): string {
  return text
    .split('\n')
    .filter(line => !line.startsWith('// PocketCode read:') && !line.trimStart().startsWith('…['))
    .join('\n');
}

function scriptsFromPackageJson(text: string): Record<string, string> {
  const clean = stripReadArtifacts(text);
  try {
    const parsed = JSON.parse(clean) as { scripts?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.scripts || {})) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    // Truncated window or trailing commas: pull the scripts block out textually instead.
    const block = clean.match(/"scripts"\s*:\s*\{([\s\S]*?)\n\s*\}/);
    if (!block) return {};
    const out: Record<string, string> = {};
    for (const m of block[1].matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g)) {
      out[m[1]] = m[2];
    }
    return out;
  }
}

export function detectProjectCommandsFrom(files: ProjectFileText): ProjectCommand[] {
  const commands: ProjectCommand[] = [];

  if (files.packageJson?.trim()) {
    const scripts = scriptsFromPackageJson(files.packageJson);
    const manager = packageManagerFor(files.packageJson);
    const pick = (names: string[]): string | null =>
      names.find(n => typeof scripts[n] === 'string') || null;

    const testScript = pick(['test', 'test:unit', 'vitest', 'jest']);
    if (testScript) {
      commands.push({
        kind: 'test',
        argv: npmRunArgv(manager, testScript),
        source: `package.json scripts.${testScript}`,
      });
    }
    const typecheckScript = pick(['typecheck', 'type-check', 'tsc', 'check']);
    if (typecheckScript) {
      commands.push({
        kind: 'typecheck',
        argv: npmRunArgv(manager, typecheckScript),
        source: `package.json scripts.${typecheckScript}`,
      });
    }
    const buildScript = pick(['build', 'compile']);
    if (buildScript) {
      commands.push({
        kind: 'build',
        argv: npmRunArgv(manager, buildScript),
        source: `package.json scripts.${buildScript}`,
      });
    }
    const lintScript = pick(['lint', 'eslint']);
    if (lintScript) {
      commands.push({
        kind: 'lint',
        argv: npmRunArgv(manager, lintScript),
        source: `package.json scripts.${lintScript}`,
      });
    }
  }

  if (files.cargoToml?.trim()) {
    const workspaceOnly = /^\s*\[workspace\]/m.test(files.cargoToml)
      && !/^\s*\[package\]/m.test(files.cargoToml);
    const suffix = workspaceOnly ? ['--workspace'] : [];
    commands.push({
      kind: 'typecheck',
      argv: ['cargo', 'check', ...suffix],
      source: 'Cargo.toml',
    });
    commands.push({
      kind: 'test',
      argv: ['cargo', 'test', ...suffix],
      source: 'Cargo.toml',
    });
  }

  if (files.pyprojectToml?.trim()) {
    const hasPytest = /pytest/.test(files.pyprojectToml);
    if (hasPytest) {
      commands.push({ kind: 'test', argv: ['pytest', '-q'], source: 'pyproject.toml' });
    }
  }

  if (files.goMod?.trim()) {
    commands.push({ kind: 'test', argv: ['go', 'test', './...'], source: 'go.mod' });
    commands.push({ kind: 'build', argv: ['go', 'build', './...'], source: 'go.mod' });
  }

  if (files.makefile?.trim()) {
    if (/^test\s*:/m.test(files.makefile)) {
      commands.push({ kind: 'test', argv: ['make', 'test'], source: 'Makefile target test' });
    }
    if (/^build\s*:/m.test(files.makefile)) {
      commands.push({ kind: 'build', argv: ['make', 'build'], source: 'Makefile target build' });
    }
  }

  // One command per kind: the first detection wins (package.json before generic fallbacks).
  const seen = new Set<string>();
  return commands.filter((c) => {
    if (seen.has(c.kind)) return false;
    seen.add(c.kind);
    return true;
  });
}

export function formatProjectCommands(commands: ProjectCommand[]): string {
  if (commands.length === 0) return '';
  const lines = commands.map(
    c => `- ${c.kind}: run_command argv ${JSON.stringify(c.argv)}  (from ${c.source})`,
  );
  return `PROJECT COMMANDS (detected — use these to verify your work):\n${lines.join('\n')}`;
}

export async function detectProjectCommands(workspaceRoot: string): Promise<ProjectCommand[]> {
  const files: ProjectFileText = {};
  await Promise.all(
    PROJECT_FILES.map(async ([key, path]) => {
      try {
        const text = await cwReadFile(workspaceRoot, path, 0, 400);
        const trimmed = (text || '').trim();
        if (!trimmed || /^\(?(file not found|no such file)/i.test(trimmed)) return;
        files[key] = trimmed;
      } catch {
        // Missing project file just means that ecosystem is not in play.
      }
    }),
  );
  return detectProjectCommandsFrom(files);
}
