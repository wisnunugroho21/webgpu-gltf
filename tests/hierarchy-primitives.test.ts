import { expect, test } from 'vitest';
import { buildNodeForest, type NodeHierarchyIssue } from '../src/gltf/hierarchy';
import { collectInstances, selectedSceneNodes } from '../src/gltf/scene';
import { validateMetadata } from '../src/gltf/validation';
import { AssetBudget, assetLimits, AssetValidationError } from '../src/gltf/limits';
import { Pose } from '../src/scene/pose';
import { descendantClosure } from '../src/scene/hierarchy';
import { World } from '../src/engine/world';
import type { Gltf, Asset } from '../src/gltf/types';

function reject(issue: NodeHierarchyIssue): never {
  throw new Error(issue.kind);
}
function asset(gltf: Gltf): Asset {
  return { gltf, buffers: [], images: [], warnings: [] };
}
function validate(gltf: Gltf) {
  validateMetadata(gltf, new AssetBudget(assetLimits(), 'hierarchy.gltf'));
}
function branching(): Gltf {
  return {
    asset: { version: '2.0' },
    nodes: [
      { children: [3, 1], translation: [10, 0, 0] },
      { children: [4], translation: [2, 0, 0] },
      { translation: [4, 0, 0] },
      { children: [2], translation: [3, 0, 0], scale: [-1, 1, 1] },
      { translation: [5, 0, 0] },
      { translation: [100, 0, 0] },
    ],
  };
}

test('complete forests retain authored child order and root order even when parents occur later', () => {
  const gltf = branching();
  const forest = buildNodeForest(gltf.nodes!, reject);
  expect(forest.order).toEqual([0, 3, 2, 1, 4, 5]);
  expect([...forest.parents]).toEqual([-1, 0, 3, 0, 1, -1]);
  expect(selectedSceneNodes(gltf)).toEqual(forest.order);
  const pose = new Pose(asset(gltf), []);
  expect(pose.nodes.map((node) => node.world[12])).toEqual([10, 12, 9, 13, 17, 100]);
});

test('selected membership and mesh collection share authored roots, branch state and winding', () => {
  const gltf = branching();
  const primitive = { attributes: { POSITION: 0 } };
  gltf.meshes = [{ primitives: [primitive] }];
  for (const node of gltf.nodes!) node.mesh = 0;
  gltf.scenes = [{ nodes: [5, 0] }];
  const selected = selectedSceneNodes(gltf);
  expect(selected).toEqual([5, 0, 3, 2, 1, 4]);
  const draws = collectInstances(gltf).get(primitive)!;
  expect(draws.map((draw) => draw.node)).toEqual(selected);
  expect(draws.map((draw) => draw.world[12])).toEqual([100, 10, 13, 9, 12, 17]);
  expect(draws.map((draw) => draw.mirrored)).toEqual([false, false, true, true, false, false]);
  expect(draws[2].normal[0]).toBe(-1);
});

test.each([
  ['cycle', [{}, { children: [2] }, { children: [1] }]],
  ['missing child', [{}, { children: [99] }]],
  ['fractional child', [{}, { children: [0.5] }]],
  ['multiple parents', [{}, { children: [3] }, { children: [3] }, {}]],
])(
  'selection ignores an unselected %s while decoding and poses validate every node',
  (_name, nodes) => {
    const gltf: Gltf = { asset: { version: '2.0' }, nodes, scenes: [{ nodes: [0] }] };
    expect(selectedSceneNodes(gltf)).toEqual([0]);
    expect(collectInstances(gltf).size).toBe(0);
    expect(() => new Pose(asset(gltf), [])).toThrow(/node hierarchy/);
    expect(() => validate(gltf)).toThrow(AssetValidationError);
  },
);

test.each([
  ['duplicate roots', [{}, {}], [0, 0]],
  ['reachable cycle', [{ children: [1] }, { children: [0] }], [0]],
  ['shared descendant', [{ children: [1, 2] }, { children: [3] }, { children: [3] }, {}], [0]],
  ['missing child', [{ children: [9] }], [0]],
])('selected traversal rejects %s for both mesh and light membership', (_name, nodes, roots) => {
  const gltf: Gltf = { asset: { version: '2.0' }, nodes, scenes: [{ nodes: roots }] };
  expect(() => selectedSceneNodes(gltf)).toThrow(
    'Scene has an invalid node, cycle, or multiple parents',
  );
  expect(() => collectInstances(gltf)).toThrow(
    'Scene has an invalid node, cycle, or multiple parents',
  );
});

test('an empty authored scene selects nothing, but pose validation still rejects a disconnected cycle', () => {
  const gltf: Gltf = { asset: { version: '2.0' }, nodes: [{ children: [0] }], scenes: [{}] };
  expect(selectedSceneNodes(gltf)).toEqual([]);
  expect(collectInstances(gltf).size).toBe(0);
  expect(() => new Pose(asset(gltf), [])).toThrow('Cycle in node hierarchy');
  expect(() => validate(gltf)).toThrow('nodes: Node hierarchy contains a cycle');
  expect(buildNodeForest([], reject)).toMatchObject({ order: [] });
});

test('scene-root validation remains a decoding rule rather than global validation during selection', () => {
  const gltf: Gltf = {
    asset: { version: '2.0' },
    nodes: [{ children: [1] }, {}],
    scenes: [{ nodes: [1] }],
  };
  expect(selectedSceneNodes(gltf)).toEqual([1]);
  expect(() => validate(gltf)).toThrow('scenes[0].nodes: Scene requires unique root nodes');
  expect(() => new Pose(asset(gltf), [])).not.toThrow();
});

test('default scene selection and no-scene inference keep distinct behavior', () => {
  const gltf = branching();
  gltf.scenes = [{ nodes: [5] }, { nodes: [0] }];
  gltf.scene = 1;
  expect(selectedSceneNodes(gltf)).toEqual([0, 3, 2, 1, 4]);
  gltf.scene = 9;
  expect(() => selectedSceneNodes(gltf)).toThrow('Invalid default scene');
  expect(() => collectInstances(gltf)).toThrow('Invalid default scene');
  gltf.scenes = undefined;
  expect(selectedSceneNodes(gltf)).toEqual([0, 3, 2, 1, 4, 5]);
});

test('forest failures retain caller-owned source/path diagnostics', () => {
  const gltf: Gltf = { asset: { version: '2.0' }, nodes: [{ children: [1, 1] }, {}] };
  expect(() => validate(gltf)).toThrow(
    'Asset hierarchy.gltf: nodes[0].children: Node has multiple parents',
  );
  expect(() => new Pose(asset(gltf), [])).toThrow('Invalid node hierarchy');
  gltf.nodes![0].children = 'bad' as unknown as number[];
  expect(() => validate(gltf)).toThrow('nodes[0].children: Expected an array');
  expect(() => new Pose(asset(gltf), [])).toThrow('Invalid node hierarchy');
});

test('transform validation remains with instance collection, including singular skinned node policy', () => {
  const primitive = { attributes: { POSITION: 0 } };
  const gltf: Gltf = {
    asset: { version: '2.0' },
    meshes: [{ primitives: [primitive] }],
    nodes: [{ mesh: 0, scale: [0, 1, 1] }],
  };
  expect(selectedSceneNodes(gltf)).toEqual([0]);
  expect(() => collectInstances(gltf)).toThrow('singular transform');
  gltf.nodes![0].skin = 0;
  expect(collectInstances(gltf).get(primitive)![0].normal[0]).toBe(1);
});

test('descendant expansion deduplicates overlapping roots and cycles without treating reachability as validation', () => {
  const children = new Map([
    ['root', ['left', 'right']],
    ['left', ['leaf']],
    ['right', ['leaf']],
    ['leaf', ['root']],
  ]);
  const visits: string[] = [];
  const closure = descendantClosure(['root', 'root'], (node) => {
    visits.push(node);
    return children.get(node) ?? [];
  });
  expect([...closure]).toEqual(['root', 'right', 'leaf', 'left']);
  expect(visits).toEqual([...closure]);
  expect(descendantClosure<string>([], (node) => children.get(node) ?? []).size).toBe(0);
});

test('subtree deletion terminates in a staged cycle and a net no-op preserves the live cache', () => {
  const world = new World();
  const existing = world.createEntity({ id: 'existing' });
  world.updateTransforms();
  const topology = world.hierarchyRevision,
    membership = world.structureRevision;
  expect(
    world.applyChanges([
      { type: 'create', entity: { id: 'a' } },
      { type: 'create', entity: { id: 'b', parent: 'a' } },
      { type: 'reparent', id: 'a', parent: 'b' },
      { type: 'destroy', id: 'a' },
    ]),
  ).toEqual([]);
  expect(world.entities).toEqual([existing]);
  expect(world.hierarchyRevision).toBe(topology);
  expect(world.structureRevision).toBe(membership);
  world.updateTransforms();
  expect(world.hierarchyStats).toMatchObject({ visitedEntities: 0, traversalRebuilds: 0 });
});

test('full-forest order and descendant expansion handle deep chains without recursion', () => {
  const count = 25_000;
  const nodes = Array.from({ length: count }, (_, i) =>
    i + 1 < count ? { children: [i + 1] } : {},
  );
  const forest = buildNodeForest(nodes, reject);
  expect(forest.order.length).toBe(count);
  expect(forest.order[0]).toBe(0);
  expect(forest.order.at(-1)).toBe(count - 1);
  const closure = descendantClosure([0], (i) => nodes[i].children ?? []);
  expect(closure.size).toBe(count);
  expect(closure.has(count - 1)).toBe(true);
});
