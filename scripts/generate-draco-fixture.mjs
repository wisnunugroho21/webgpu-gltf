// Original four-vertex fixture, encoded offline so browser tests need no network or encoder.
import draco from 'draco3dgltf';
import { writeFile, mkdir } from 'node:fs/promises';
const lib = await draco.createEncoderModule();
const mesh = new lib.Mesh(),
  builder = new lib.MeshBuilder(),
  encoder = new lib.Encoder();
const output = new lib.DracoInt8Array();
const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
const colors = new Uint8Array([
  128, 255, 64, 255, 128, 255, 64, 255, 128, 255, 64, 255, 128, 255, 64, 255,
]);
try {
  builder.AddFacesToMesh(mesh, 2, new Uint32Array([0, 1, 2, 0, 2, 3]));
  const ids = {
    POSITION: builder.AddFloatAttributeToMesh(mesh, lib.POSITION, 4, 3, positions),
    NORMAL: builder.AddFloatAttributeToMesh(mesh, lib.NORMAL, 4, 3, normals),
    COLOR_0: builder.AddUInt8Attribute(mesh, lib.COLOR, 4, 4, colors),
  };
  encoder.SetEncodingMethod(lib.MESH_SEQUENTIAL_ENCODING);
  const size = encoder.EncodeMeshToDracoBuffer(mesh, output);
  if (size <= 0) throw new Error('Fixture encode failed.');
  const bytes = Uint8Array.from({ length: size }, (_, i) => output.GetValue(i));
  const gltf = {
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_draco_mesh_compression'],
    extensionsRequired: ['KHR_draco_mesh_compression'],
    buffers: [
      {
        byteLength: size,
        uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`,
      },
    ],
    bufferViews: [{ buffer: 0, byteLength: size }],
    accessors: [
      { componentType: 5126, type: 'VEC3', count: 4 },
      { componentType: 5126, type: 'VEC3', count: 4 },
      { componentType: 5121, type: 'VEC4', count: 4, normalized: true },
      { componentType: 5123, type: 'SCALAR', count: 6 },
    ],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 },
            indices: 3,
            material: 0,
            extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: ids } },
          },
        ],
      },
    ],
    materials: [{ extensions: { KHR_materials_unlit: {} } }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  await mkdir(new URL('../tests/fixtures/compression/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../tests/fixtures/compression/quad-draco.gltf', import.meta.url),
    JSON.stringify(gltf, null, 2) + '\n',
  );
} finally {
  for (const value of [output, encoder, builder, mesh]) lib.destroy(value);
}
