/** The subset of glTF 2.0 used by this static renderer. JSON names stay spec-compatible. */
export interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  sparse?: {
    count: number;
    indices: { bufferView: number; byteOffset?: number; componentType: number };
    values: { bufferView: number; byteOffset?: number };
  };
}
export interface Primitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: unknown[];
}
export interface TextureInfo {
  index: number;
  texCoord?: number;
  extensions?: Record<string, unknown>;
}
export interface Material {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    baseColorTexture?: TextureInfo;
    metallicFactor?: number;
    roughnessFactor?: number;
    metallicRoughnessTexture?: TextureInfo;
  };
  emissiveFactor?: number[];
  emissiveTexture?: TextureInfo;
  normalTexture?: TextureInfo;
  occlusionTexture?: TextureInfo;
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff?: number;
  doubleSided?: boolean;
  extensions?: Record<string, unknown>;
}
export interface Gltf {
  asset: { version: string; minVersion?: string };
  buffers?: { uri?: string; byteLength: number }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  accessors?: Accessor[];
  meshes?: { primitives: Primitive[] }[];
  nodes?: {
    children?: number[];
    mesh?: number;
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    skin?: number;
  }[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  materials?: Material[];
  textures?: { source?: number; sampler?: number }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }[];
  extensionsRequired?: string[];
  animations?: unknown[];
}
export interface Asset {
  gltf: Gltf;
  buffers: ArrayBuffer[];
  images: Blob[];
  warnings: string[];
}
