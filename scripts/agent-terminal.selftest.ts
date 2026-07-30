/**
 * Self-test for the verification layer:
 *   - project test/build/typecheck command detection per ecosystem
 *   - read_file header stripping (package.json arrives with a PocketCode header line)
 *   - terminal status labels and output tailing
 *
 * Run: npm run test:agent-terminal
 */
import {
  detectProjectCommandsFrom,
  formatProjectCommands,
  stripReadArtifacts,
} from '../src/codeWorkspace/projectCommands';
import { tailLines, terminalStatusLabel } from '../src/codeWorkspace/terminalTypes';
import type { TerminalSnapshot } from '../src/codeWorkspace/terminalTypes';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) return;
  failures += 1;
  console.error('FAIL', name, extra);
};

const argvFor = (kind: string, cmds: ReturnType<typeof detectProjectCommandsFrom>) =>
  (cmds.find(c => c.kind === kind)?.argv || []).join(' ');

// —— package.json: scripts win, and the package manager is respected ——
const npmProject = detectProjectCommandsFrom({
  packageJson: `// PocketCode read: lines 0-20 (offset=0, window=200)
{
  "name": "app",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build": "vite build",
    "lint": "eslint ."
  }
}`,
});
check('npm test detected', argvFor('test', npmProject) === 'npm run test', argvFor('test', npmProject));
check(
  'npm typecheck detected',
  argvFor('typecheck', npmProject) === 'npm run typecheck',
  argvFor('typecheck', npmProject),
);
check('npm build detected', argvFor('build', npmProject) === 'npm run build');
check('npm lint detected', argvFor('lint', npmProject) === 'npm run lint');

const pnpmProject = detectProjectCommandsFrom({
  packageJson: '{"packageManager":"pnpm@9.0.0","scripts":{"test":"vitest"}}',
});
check('pnpm run form', argvFor('test', pnpmProject) === 'pnpm run test', argvFor('test', pnpmProject));

// Truncated JSON still yields scripts through the textual fallback.
const truncated = detectProjectCommandsFrom({
  packageJson: `{
  "scripts": {
    "test": "jest"
  },
  "dependencies": {
…[truncated at byte cap — use a smaller window or offset]`,
});
check('truncated package.json still parsed', argvFor('test', truncated) === 'npm run test', argvFor('test', truncated));

// —— Cargo: workspace manifests get --workspace ——
const cargoWorkspace = detectProjectCommandsFrom({
  cargoToml: '[workspace]\nmembers = ["crates/*"]\n',
});
check(
  'cargo workspace check',
  argvFor('typecheck', cargoWorkspace) === 'cargo check --workspace',
  argvFor('typecheck', cargoWorkspace),
);
const cargoCrate = detectProjectCommandsFrom({ cargoToml: '[package]\nname = "x"\n' });
check('cargo crate check', argvFor('typecheck', cargoCrate) === 'cargo check', argvFor('typecheck', cargoCrate));
check('cargo test', argvFor('test', cargoCrate) === 'cargo test');

// —— Other ecosystems ——
check(
  'pytest from pyproject',
  argvFor('test', detectProjectCommandsFrom({ pyprojectToml: '[tool.pytest.ini_options]\n' })) === 'pytest -q',
);
check(
  'go test',
  argvFor('test', detectProjectCommandsFrom({ goMod: 'module example.com/x\n' })) === 'go test ./...',
);
check(
  'makefile target',
  argvFor('test', detectProjectCommandsFrom({ makefile: 'test:\n\tgo test ./...\n' })) === 'make test',
);

// package.json beats a co-existing Cargo.toml for the same kind (one command per kind).
const mixed = detectProjectCommandsFrom({
  packageJson: '{"scripts":{"test":"vitest"}}',
  cargoToml: '[package]\nname = "x"\n',
});
check('one test command only', mixed.filter(c => c.kind === 'test').length === 1);
check('package.json wins', argvFor('test', mixed) === 'npm run test', argvFor('test', mixed));

// Nothing detected → empty prompt block, so the prompt never claims commands that do not exist.
check('no files means no commands', detectProjectCommandsFrom({}).length === 0);
check('empty format is empty', formatProjectCommands([]) === '');
check(
  'format lists argv as JSON',
  formatProjectCommands(npmProject).includes('["npm","run","test"]'),
  formatProjectCommands(npmProject),
);

check(
  'read header stripped',
  stripReadArtifacts('// PocketCode read: lines 0-5 (offset=0, window=120)\n{"a":1}') === '{"a":1}',
);

// —— Terminal helpers ——
const snap = (patch: Partial<TerminalSnapshot>): TerminalSnapshot => ({
  id: 't1',
  label: 'cli:npm',
  command: 'npm run test',
  background: false,
  running: false,
  exit_code: 0,
  timed_out: false,
  killed: false,
  started_at: 0,
  duration_ms: 1200,
  output: '',
  total_bytes: 0,
  truncated: false,
  ...patch,
});
check('running label', terminalStatusLabel(snap({ running: true })) === 'running');
check(
  'background label',
  terminalStatusLabel(snap({ running: true, background: true })) === 'running (background)',
);
check('success label', terminalStatusLabel(snap({})) === 'exit 0');
check('failure label', terminalStatusLabel(snap({ exit_code: 2 })) === 'exit 2');
check('timeout label', terminalStatusLabel(snap({ timed_out: true, exit_code: null })) === 'timed out');
check('killed label', terminalStatusLabel(snap({ killed: true, exit_code: null })) === 'killed');

const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
const tail = tailLines(long, 50);
check('tail keeps last lines', tail.endsWith('line 499'));
check('tail drops early lines', !tail.includes('line 100'));
check('tail notes omission', tail.includes('earlier lines omitted'));
check('short output untouched', tailLines('a\nb', 50) === 'a\nb');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('agent terminal/verification self-test: all checks passed');
