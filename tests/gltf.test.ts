import { describe, expect, it } from 'vitest';
import { demoAsset } from '../src/app/demo';
import { decodeAccessor } from '../src/gltf/accessors';
import { prepareGeometry } from '../src/gltf/geometry';
import { parseGlb } from '../src/gltf/loader';
import { collectInstances } from '../src/gltf/scene';
import type { Asset } from '../src/gltf/types';
import { pipelineArgs } from '../src/renderer/render/pipelines';

function packedAsset(values: Float32Array, offsets: number[], stride = 12): Asset {
  return {
    buffers: [values.buffer as ArrayBuffer],
    images: [],
    warnings: [],
    gltf: {
      asset: { version: '2.0' },
      bufferViews: [{ buffer: 0, byteLength: values.byteLength, byteStride: stride }],
      accessors: offsets.map((byteOffset) => ({
        bufferView: 0,
        byteOffset,
        type: 'VEC3',
        componentType: 5126,
        count: 3,
      })),
    },
  };
}

describe('WebGPU vertex layout preparation', () => {
  it('binds interleaved attributes once and canonicalizes JSON order', () => {
    const asset = demoAsset();
    const primitive = asset.gltf.meshes![0].primitives[0];
    const a = prepareGeometry(asset, primitive);
    const b = prepareGeometry(asset, { ...primitive, attributes: { NORMAL: 1, POSITION: 0 } });
    expect(a.bindings).toHaveLength(1);
    expect(a.bindings[0].layout).toEqual({
      arrayStride: 24,
      stepMode: 'vertex',
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
      ],
    });
    expect(a.bindings).toEqual(b.bindings);
  });

  it('keeps large planar offsets out of pipeline attributes', () => {
    const values = new Float32Array(1033);
    const asset = packedAsset(values, [0, 4096]);
    const geometry = prepareGeometry(asset, { attributes: { POSITION: 0, NORMAL: 1 } });
    expect(geometry.bindings).toHaveLength(2);
    const normal = geometry.bindings[1];
    const attribute = [...normal.layout.attributes][0];
    expect(normal.offset + attribute.offset).toBe(4096);
    expect(attribute.offset + 12).toBeLessThanOrEqual(normal.layout.arrayStride);
  });

  it('reuses pipeline keys across different buffer IDs and materials', () => {
    const asset = demoAsset();
    const geometry = prepareGeometry(asset, asset.gltf.meshes![0].primitives[0]);
    const shifted = {
      ...geometry,
      bindings: geometry.bindings.map((b) => ({ ...b, source: 999, offset: 5000 })),
    };
    const material = {
      alphaMode: 'OPAQUE' as const,
      doubleSided: false,
      bindGroup: {} as GPUBindGroup,
    };
    expect(JSON.stringify(pipelineArgs(geometry, material, false))).toBe(
      JSON.stringify(pipelineArgs(shifted, material, false)),
    );
    expect(pipelineArgs(geometry, material, true).mirrored).toBe(true);
  });

  it('promotes byte indices and converts triangle fans', () => {
    const asset = demoAsset();
    asset.buffers.push(new Uint8Array([0, 1, 2, 3]).buffer);
    asset.gltf.bufferViews!.push({ buffer: 1, byteLength: 4 });
    asset.gltf.accessors!.push({ bufferView: 2, type: 'SCALAR', componentType: 5121, count: 4 });
    const geometry = prepareGeometry(asset, { attributes: { POSITION: 0 }, indices: 3, mode: 6 });
    expect(geometry.topology).toBe('triangle-list');
    expect(geometry.indices).toBeInstanceOf(Uint16Array);
    expect([...geometry.indices!]).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('rejects vertex counts and out-of-bounds indices', () => {
    const asset = demoAsset();
    asset.gltf.accessors![1].count = 23;
    expect(() => prepareGeometry(asset, asset.gltf.meshes![0].primitives[0])).toThrow('count');
    const valid = demoAsset();
    new Uint16Array(valid.buffers[0], valid.gltf.bufferViews![1].byteOffset)[0] = 500;
    expect(() => prepareGeometry(valid, valid.gltf.meshes![0].primitives[0])).toThrow('Index');
  });
});

describe('accessor decoding', () => {
  it('applies normalized sparse values to a zero-initialized accessor', () => {
    const asset: Asset = {
      buffers: [new Uint8Array([1, 0, 0, 0, 255, 128, 0, 255]).buffer],
      images: [],
      warnings: [],
      gltf: {
        asset: { version: '2.0' },
        bufferViews: [
          { buffer: 0, byteLength: 1 },
          { buffer: 0, byteOffset: 4, byteLength: 4 },
        ],
      },
    };
    const values = decodeAccessor(asset, {
      type: 'VEC4',
      componentType: 5121,
      normalized: true,
      count: 3,
      sparse: {
        count: 1,
        indices: { bufferView: 0, componentType: 5121 },
        values: { bufferView: 1 },
      },
    });
    expect(values.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(values.slice(4, 8)).toEqual([1, 128 / 255, 0, 1]);
    expect(values.slice(8)).toEqual([0, 0, 0, 0]);
  });
  it('clamps signed normalized minimum and rejects truncated data', () => {
    const asset: Asset = {
      buffers: [new Int8Array([-128, 127]).buffer],
      images: [],
      warnings: [],
      gltf: { asset: { version: '2.0' }, bufferViews: [{ buffer: 0, byteLength: 2 }] },
    };
    expect(
      decodeAccessor(asset, {
        bufferView: 0,
        type: 'VEC2',
        componentType: 5120,
        normalized: true,
        count: 1,
      }),
    ).toEqual([-1, 1]);
    expect(() =>
      decodeAccessor(asset, { bufferView: 0, type: 'VEC3', componentType: 5120, count: 1 }),
    ).toThrow('bufferView');
  });
});

describe('scene transforms', () => {
  it('collects repeated meshes and respects scene selection', () => {
    const asset = demoAsset();
    const instances = collectInstances(asset.gltf);
    expect(instances.get(asset.gltf.meshes![0].primitives[0])).toHaveLength(3);
    asset.gltf.scenes = [{ nodes: [3] }];
    expect(collectInstances(asset.gltf).size).toBe(1);
  });
  it('accumulates parent transforms and identifies mirrored winding', () => {
    const asset = demoAsset();
    asset.gltf.nodes = [
      { translation: [4, 0, 0], children: [1] },
      { mesh: 0, translation: [2, 0, 0], scale: [-1, 2, 1] },
    ];
    asset.gltf.scenes = [{ nodes: [0] }];
    const instance = [...collectInstances(asset.gltf).values()][0][0];
    expect(instance.world[12]).toBe(6);
    expect(instance.normal[5]).toBe(0.5);
    expect(instance.mirrored).toBe(true);
  });
  it('rejects cycles and singular transforms', () => {
    const asset = demoAsset();
    asset.gltf.nodes![0].children = [0];
    expect(() => collectInstances(asset.gltf)).toThrow('cycle');
    asset.gltf.nodes![0].children = [];
    asset.gltf.nodes![0].scale = [0, 1, 1];
    expect(() => collectInstances(asset.gltf)).toThrow('singular');
  });
});

describe('GLB parsing', () => {
  it('reads padded JSON and rejects truncated containers', () => {
    const json = new TextEncoder().encode('{"asset":{"version":"2.0"}}');
    const length = Math.ceil(json.length / 4) * 4;
    const buffer = new ArrayBuffer(20 + length);
    const view = new DataView(buffer);
    [0x46546c67, 2, buffer.byteLength, length, 0x4e4f534a].forEach((n, i) =>
      view.setUint32(i * 4, n, true),
    );
    new Uint8Array(buffer, 20).fill(32);
    new Uint8Array(buffer, 20).set(json);
    expect(parseGlb(buffer).gltf.asset.version).toBe('2.0');
    expect(() => parseGlb(buffer.slice(0, -1))).toThrow('header');
    view.setUint32(12, length + 4, true);
    expect(() => parseGlb(buffer)).toThrow('length');
  });
});
