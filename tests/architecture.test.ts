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
    if (!/^\.\.\/src\/(gltf|animation|scene|engine)\//.test(path)) continue;
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

test('renderer modules do not schedule browser frames', () => {
  for (const [path, source] of Object.entries(sources)) {
    if (path.includes('/src/renderer/'))
      expect(source, path).not.toMatch(/\b(?:requestAnimationFrame|cancelAnimationFrame)\s*\(/);
  }
});

test('renderer camera and frame phases cannot evaluate simulation or attach input', () => {
  for (const [path, source] of Object.entries(sources)) {
    if (!path.includes('/src/renderer/')) continue;
    expect(source, path).not.toMatch(
      /(?:animation|scene\.world\.source|world)\.(?:update|updateTransforms)\s*\(/,
    );
    expect(source, path).not.toMatch(
      /\.(?:addEventListener|removeEventListener)\s*\(\s*['"](?:pointer\w+|wheel|key\w+)/,
    );
  }
});

test('production modules never import migration test or benchmark helpers', () => {
  for (const [path, source] of Object.entries(sources))
    for (const specifier of imports(source))
      expect(specifier, path).not.toMatch(/\/(tests|browser-tests|benchmarks)\//);
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

test('renderer facade delegates device lifetime to one owner', () => {
  const facade = sources['../src/renderer/renderer.ts'];
  expect(facade).not.toMatch(/\brequest(?:Adapter|Device)\s*\(/);
  expect(facade).not.toMatch(/\bcontext\.(?:configure|unconfigure)\s*\(/);
  expect(facade).not.toMatch(/\bdevice\.destroy\s*\(/);
  expect(facade).not.toMatch(
    /\bprivate\s+(?:device|context|scene|bindings|builder|viewport|memory|gpuTimer)\s*[:?]/,
  );
});

test('game entry point and simulation preserve application boundaries', () => {
  const entry = sources['../src/game/main.ts'];
  expect(entry).not.toMatch(
    /\b(?:EngineRuntime|Renderer|RapierPhysics|FollowCamera|loadSaveState|requestAnimationFrame)\b/,
  );
  for (const path of ['simulation', 'locomotion']) {
    const policy = sources[`../src/game/${path}.ts`];
    expect(policy).not.toMatch(/\b(?:document|window|sessionStorage|localStorage)\s*\./);
    expect(imports(policy)).not.toContain('./session');
    expect(imports(policy)).not.toContain('./presentation');
    expect(imports(policy)).not.toContain('./controls');
  }
});
