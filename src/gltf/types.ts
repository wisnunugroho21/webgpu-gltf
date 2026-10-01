/** The glTF 2.0 fields used by the renderer. JSON names stay spec-compatible. */
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
  targets?: Record<string, number>[];
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
  normalTexture?: TextureInfo & { scale?: number };
  occlusionTexture?: TextureInfo & { strength?: number };
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
  meshes?: { primitives: Primitive[]; weights?: number[] }[];
  nodes?: {
    children?: number[];
    mesh?: number;
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    skin?: number;
    weights?: number[];
  }[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  materials?: Material[];
  textures?: { source?: number; sampler?: number }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }[];
  extensionsRequired?: string[];
  skins?: { joints: number[]; inverseBindMatrices?: number; skeleton?: number }[];
  animations?: Animation[];
}
export interface Animation {
  name?: string;
  samplers: { input: number; output: number; interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE' }[];
  channels: {
    sampler: number;
    target: { node?: number; path: 'translation' | 'rotation' | 'scale' | 'weights' };
  }[];
}
export interface Asset {
  gltf: Gltf;
  buffers: ArrayBuffer[];
  images: Blob[];
  warnings: string[];
}
