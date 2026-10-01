import { expect, test } from 'vitest';

// Read sources without evaluating WebGPU globals. These checks protect module boundaries,
// while the browser suite verifies actual resource ownership, phases, and rendered output.
const sources = import.meta.glob<string>('../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const imports = (source: string) =>
  [...source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)].map((match) => match[1]);

function resolve(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return;
  const segments = from.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '..') segments.pop();
    else if (segment !== '.') segments.push(segment);
  }
  const base = segments.join('/');
  return [base, `${base}.ts`, `${base}/index.ts`].find((path) => path in sources);
}

test('CPU asset, animation and scene modules do not depend on the renderer or viewer', () => {
  for (const [path, source] of Object.entries(sources)) {
    if (!/^\.\.\/src\/(gltf|animation|scene)\//.test(path)) continue;
    for (const specifier of imports(source)) {
      const dependency = resolve(path, specifier);
      expect(dependency ?? specifier, `${path} imports ${specifier}`).not.toMatch(
        /\/src\/(renderer|app)\//,
      );
    }
  }
});

test('renderer modules do not depend on viewer controls or fixtures', () => {
  for (const [path, source] of Object.entries(sources)) {
    if (!path.includes('/src/renderer/')) continue;
    for (const specifier of imports(source)) {
      const dependency = resolve(path, specifier);
      expect(dependency ?? specifier, `${path} imports ${specifier}`).not.toMatch(/\/src\/app\//);
      expect(specifier, path).not.toMatch(/\/(tests|browser-tests)\//);
    }
  }
});

test('source modules have no circular static dependencies', () => {
  const visited = new Set<string>();
  const active: string[] = [];
  const visit = (path: string) => {
    expect(active, `Circular dependency: ${[...active, path].join(' → ')}`).not.toContain(path);
    if (visited.has(path)) return;
    active.push(path);
    for (const specifier of imports(sources[path])) {
      const dependency = resolve(path, specifier);
      if (dependency) visit(dependency);
    }
    active.pop();
    visited.add(path);
  };
  Object.keys(sources).forEach(visit);
});
