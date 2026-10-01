import { expect, test } from 'vitest';
import { animatedAsset } from './fixtures/animated';
import { Pose } from '../src/scene/pose';
import { Deformation } from '../src/scene/deformation';
import { OcclusionDependencies } from '../src/renderer/scene/occlusion-dependencies';
import type { Scene } from '../src/renderer/scene/types';

function fixture(alphaMode: 'OPAQUE' | 'MASK' | 'BLEND', transmission = false) {
  const asset = animatedAsset(),
    pose = new Pose(asset);
  const data = new Deformation(asset, asset.gltf.meshes![0].primitives[0], 0, pose);
  const scene = {
    pose,
    updates: [
      {
        node: 0,
        draw: { firstInstance: 7, material: { alphaMode, transmission } },
        deformation: { data },
      },
    ],
  } as unknown as Scene;
  const dependencies = new OcclusionDependencies();
  dependencies.update(scene);
  return { pose, data, scene, dependencies };
}

test('skinned geometry tracks active joints and morphs while ignoring unrelated transforms', () => {
  const { pose, scene, dependencies } = fixture('OPAQUE');
  pose.evaluate(2, 1); // A different mesh moves; this skinned receiver is unchanged.
  expect(dependencies.update(scene)).toEqual({ depthChanged: false, receivers: [] });
  // Mesh-node movement is not geometry movement for world-space skinning.
  pose.clips[2].tracks[0].node = 0;
  pose.evaluate(2, 1.5);
  expect(dependencies.update(scene)).toEqual({ depthChanged: false, receivers: [] });
  pose.evaluate(0, 1); // Active influencing joint moves.
  expect(dependencies.update(scene)).toEqual({ depthChanged: true, receivers: [7] });
  pose.evaluate(1, 1); // Morph weights change even if the world matrix doesn't.
  expect(dependencies.update(scene)).toEqual({ depthChanged: true, receivers: [7] });
  expect(dependencies.update(scene)).toEqual({ depthChanged: false, receivers: [] });
});

test('MASK invalidates depth; BLEND and transmission changes invalidate only their receiver', () => {
  for (const [mode, transmission, depthChanged] of [
    ['MASK', false, true],
    ['BLEND', false, false],
    ['OPAQUE', true, false],
  ] as const) {
    const { pose, scene, dependencies } = fixture(mode, transmission);
    pose.evaluate(1, 1);
    expect(dependencies.update(scene)).toEqual({ depthChanged, receivers: [7] });
  }
});
