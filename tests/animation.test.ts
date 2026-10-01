import { describe, expect, it } from 'vitest';
import { Pose } from '../src/scene/pose';
import { sampleTrack, type Track } from '../src/animation/tracks';
import { Deformation } from '../src/scene/deformation';
import { animatedAsset } from './fixtures/animated';

function track(overrides: Partial<Track>): Track {
  return {
    node: 0,
    path: 'weights',
    times: [1, 3],
    values: [0, 1],
    width: 1,
    interpolation: 'LINEAR',
    ...overrides,
  };
}
describe('animation interpolation', () => {
  it('clamps endpoints and respects exact STEP keys', () => {
    const out: number[] = [];
    sampleTrack(track({}), -1, out);
    expect(out[0]).toBe(0);
    sampleTrack(track({}), 2, out);
    expect(out[0]).toBe(0.5);
    sampleTrack(track({}), 4, out);
    expect(out[0]).toBe(1);
    sampleTrack(track({ interpolation: 'STEP' }), 2.9, out);
    expect(out[0]).toBe(0);
    sampleTrack(track({ interpolation: 'STEP' }), 3, out);
    expect(out[0]).toBe(1);
  });
  it('scales cubic tangents by seconds and normalizes cubic rotations', () => {
    const out: number[] = [];
    sampleTrack(track({ interpolation: 'CUBICSPLINE', values: [0, 0, 1, 0, 0, 0] }), 2, out);
    expect(out[0]).toBe(0.25); // h10(0.5) * two-second interval
    sampleTrack(
      track({
        path: 'rotation',
        width: 4,
        interpolation: 'CUBICSPLINE',
        values: [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
      }),
      2,
      out,
    );
    expect(Math.hypot(...out)).toBeCloseTo(1);
  });
  it('uses shortest-path quaternion slerp instead of component interpolation', () => {
    const out: number[] = [];
    sampleTrack(track({ path: 'rotation', width: 4, values: [0, 0, 0, 1, 0, 0, 0, -1] }), 2, out);
    expect(Math.abs(out[3])).toBeCloseTo(1);
  });
});

describe('pose and deformation', () => {
  it('resets unanimated properties on clip change and propagates hierarchy', () => {
    const pose = new Pose(animatedAsset());
    pose.evaluate(2, 2);
    expect(pose.nodes[3].world[12]).toBe(3);
    pose.evaluate(1, 1);
    expect(pose.nodes[3].world[12]).toBe(2);
    expect(pose.nodes[3].weights).toEqual([0.5]);
    pose.evaluate(-1, 0);
    expect(pose.nodes[0].weights).toEqual([0]);
    expect(pose.nodes[3].weights).toEqual([0.75]);
  });
  it('morphs positions/normals/tangents before skinning, ignoring mesh-node transforms', () => {
    const asset = animatedAsset(),
      pose = new Pose(asset),
      primitive = asset.gltf.meshes![0].primitives[0];
    const deform = new Deformation(asset, primitive, 0, pose);
    pose.nodes[0].weights[0] = 1;
    pose.nodes[2].world[12] = 2; // translated joint after the default inverse bind cancels Y
    deform.update();
    expect([...deform.streams[0].values]).toEqual([-0.5, 0, 0, 0.5, 0, 0, 2, 3, 0]);
    expect(deform.streams[1].values[0]).toBeCloseTo(0.2);
    expect(deform.streams[2].values[1]).toBeCloseTo(0.2);
    expect(deform.streams[2].values[3]).toBe(1);
  });
  it('keeps node morph weights independent and preserves source arrays across repeated updates', () => {
    const asset = animatedAsset(),
      pose = new Pose(asset),
      primitive = asset.gltf.meshes![0].primitives[0];
    const a = new Deformation(asset, primitive, 0, pose),
      b = new Deformation(asset, primitive, 3, pose);
    expect(a.streams[0].values[7]).toBe(2);
    expect(b.streams[0].values[7]).toBe(2.75);
    b.update();
    expect(b.streams[0].values[7]).toBe(2.75);
    expect(b.streams[0].base[7]).toBe(2);
  });
  it('defaults omitted inverse binds to identity and rejects invalid joint indices', () => {
    const asset = animatedAsset();
    delete asset.gltf.skins![0].inverseBindMatrices;
    const pose = new Pose(asset),
      primitive = asset.gltf.meshes![0].primitives[0];
    expect(new Deformation(asset, primitive, 0, pose).streams[0].values[7]).toBe(3);
    const jointAccessor = asset.gltf.accessors![primitive.attributes.JOINTS_0];
    new Uint8Array(asset.buffers[asset.gltf.bufferViews![jointAccessor.bufferView!].buffer])[0] =
      100;
    expect(() => new Deformation(asset, primitive, 0, pose)).toThrow('range');
  });
  it('rejects malformed animation outputs and non-increasing times', () => {
    const asset = animatedAsset();
    const input = asset.gltf.accessors![asset.gltf.animations![0].samplers[0].input];
    new Float32Array(asset.buffers[asset.gltf.bufferViews![input.bufferView!].buffer])[1] = 0;
    expect(() => new Pose(asset)).toThrow('increase');
    const other = animatedAsset();
    other.gltf.accessors![other.gltf.animations![0].samplers[0].output].count = 1;
    expect(() => new Pose(other)).toThrow('output');
  });
  it('applies sparse morph deltas and node weights without an animation clip', () => {
    const asset = animatedAsset(),
      primitive = asset.gltf.meshes![0].primitives[0];
    delete asset.gltf.animations;
    const target = asset.gltf.accessors![primitive.targets![0].POSITION];
    const valuesView = target.bufferView!;
    delete target.bufferView;
    const buffer = asset.buffers.length;
    asset.buffers.push(new Uint8Array([2]).buffer);
    const indicesView = asset.gltf.bufferViews!.length;
    asset.gltf.bufferViews!.push({ buffer, byteLength: 1 });
    target.sparse = {
      count: 1,
      indices: { bufferView: indicesView, componentType: 5121 },
      values: { bufferView: valuesView, byteOffset: 24 },
    };
    expect(new Deformation(asset, primitive, 3, new Pose(asset)).streams[0].values[7]).toBe(2.75);
  });
  it('combines multiple influence sets and normalizes their total weight', () => {
    const asset = animatedAsset(),
      primitive = asset.gltf.meshes![0].primitives[0];
    primitive.attributes.JOINTS_1 = primitive.attributes.JOINTS_0;
    primitive.attributes.WEIGHTS_1 = primitive.attributes.WEIGHTS_0;
    const pose = new Pose(asset);
    pose.nodes[2].world[12] = 2;
    const deformed = new Deformation(asset, primitive, 0, pose);
    expect(deformed.streams[0].values[6]).toBe(2); // duplicated sets must not double translation
  });
});
