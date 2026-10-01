import { expect, test } from 'vitest';
import { MeshoptEncoder } from 'meshoptimizer/encoder';
import { bufferRange, decodeMeshopt } from '../src/gltf/compression/geometry';
import { prepareGeometry } from '../src/gltf/geometry';
import { decodeAccessor } from '../src/gltf/accessors';
import { DeformationInputCache } from '../src/scene/deformation-inputs';
import type { Asset, Gltf } from '../src/gltf/types';

test('meshopt decodes vertex and both index modes without changing accessor offsets', async () => {
  await MeshoptEncoder.ready;
  for (const mode of ['ATTRIBUTES', 'TRIANGLES', 'INDICES'] as const) {
    const values =
      mode === 'ATTRIBUTES'
        ? new Float32Array([1, 2, 3, 4, 5, 6])
        : new Uint32Array([0, 1, 2, 2, 1, 3]);
    const stride = mode === 'ATTRIBUTES' ? 12 : 4;
    const count = values.byteLength / stride;
    const encoded = MeshoptEncoder.encodeGltfBuffer(
      new Uint8Array(values.buffer),
      count,
      stride,
      mode,
    );
    const source = new Uint8Array(encoded.length + 16);
    source.set(encoded, 8);
    const buffers = [source.buffer, new ArrayBuffer(0)];
    const gltf: Gltf = {
      asset: { version: '2.0' },
      bufferViews: [
        {
          buffer: 1,
          byteLength: values.byteLength,
          extensions: {
            EXT_meshopt_compression: {
              buffer: 0,
              byteOffset: 8,
              byteLength: encoded.length,
              byteStride: stride,
              count,
              mode,
            },
          },
        },
      ],
    };
    await decodeMeshopt(gltf, buffers);
    expect(new Uint8Array(buffers[gltf.bufferViews![0].buffer])).toEqual(
      new Uint8Array(values.buffer),
    );
    expect(gltf.bufferViews![0].byteOffset).toBe(0);
    expect(new Uint8Array(buffers[0])).toEqual(source);
  }
});

test('meshopt decodes filtered animation floats', async () => {
  await MeshoptEncoder.ready;
  const values = new Float32Array([0.5, 1, 2, 3, 4, 5]);
  const filtered = MeshoptEncoder.encodeFilterExp(values, 2, 12, 24, 'Separate');
  const encoded = MeshoptEncoder.encodeGltfBuffer(filtered, 2, 12, 'ATTRIBUTES');
  const buffers = [encoded.slice().buffer];
  const gltf: Gltf = {
    asset: { version: '2.0' },
    bufferViews: [
      {
        buffer: 0,
        byteLength: 24,
        extensions: {
          EXT_meshopt_compression: {
            buffer: 0,
            byteLength: encoded.length,
            byteStride: 12,
            count: 2,
            mode: 'ATTRIBUTES',
            filter: 'EXPONENTIAL',
          },
        },
      },
    ],
  };
  await decodeMeshopt(gltf, buffers);
  expect([...new Float32Array(buffers[gltf.bufferViews![0].buffer])]).toEqual([...values]);
});

test('invalid compressed ranges and inconsistent meshopt metadata fail early', async () => {
  expect(() => bufferRange([new ArrayBuffer(4)], 0, 2, 4)).toThrow('source buffer');
  expect(() => bufferRange([new ArrayBuffer(4)], 0, -1, 2)).toThrow();
  const gltf: Gltf = {
    asset: { version: '2.0' },
    bufferViews: [
      {
        buffer: 0,
        byteLength: 16,
        extensions: {
          EXT_meshopt_compression: {
            buffer: 0,
            byteLength: 4,
            byteStride: 12,
            count: 2,
            mode: 'ATTRIBUTES',
          },
        },
      },
    ],
  };
  await expect(decodeMeshopt(gltf, [new ArrayBuffer(4)])).rejects.toThrow('metadata');
});

test('quantized positions and morph deltas use normalized values for rendering and bounds', () => {
  const positions = new Int16Array([-32767, 0, 32767, 0, 32767, 0, 32767, 0, -32767]);
  const asset: Asset = {
    warnings: [],
    images: [],
    buffers: [positions.buffer],
    gltf: {
      asset: { version: '2.0' },
      extensionsRequired: ['KHR_mesh_quantization'],
      bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5122, normalized: true, type: 'VEC3', count: 3 }],
    },
  };
  const primitive = { attributes: { POSITION: 0 }, targets: [{ POSITION: 0 }] };
  const geometry = prepareGeometry(asset, primitive);
  expect(geometry.positions).toEqual([-1, 0, 1, 0, 1, 0, 1, 0, -1]);
  expect(geometry.bindings[0].source).toBeInstanceOf(Float32Array);
  const inputs = new DeformationInputCache(asset).get(primitive);
  expect(inputs.streams[0].targets[0]).toEqual(decodeAccessor(asset, asset.gltf.accessors![0]));
  expect([...inputs.ranges[0].min]).toEqual([-1, 0, -1]);
  delete asset.gltf.extensionsRequired;
  expect(() => prepareGeometry(asset, primitive)).toThrow('KHR_mesh_quantization');
});
