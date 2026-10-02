import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// Keep network opt-in cross-platform; PowerShell and POSIX env syntax differ.
const [mode, ...args] = process.argv.slice(2);
if (mode !== 'offline' && mode !== 'remote') throw new Error('Expected offline or remote.');
const env = { ...process.env };
delete env.TEST_REMOTE_MODELS;
if (mode === 'remote') env.TEST_REMOTE_MODELS = '1';
const require = createRequire(import.meta.url);
const child = spawn(
  process.execPath,
  [
    require.resolve('@playwright/test/cli'),
    'test',
    mode === 'offline' ? '--grep-invert' : '--grep',
    '@remote',
    ...args,
  ],
  { env, stdio: 'inherit', windowsHide: true },
);
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
