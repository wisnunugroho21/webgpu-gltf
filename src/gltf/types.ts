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
  extensions?: {
    KHR_draco_mesh_compression?: { bufferView: number; attributes: Record<string, number> };
  };
}
export interface BufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  extensions?: {
    EXT_meshopt_compression?: {
      buffer: number;
      byteOffset?: number;
      byteLength: number;
      byteStride: number;
      count: number;
      mode: 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES';
      filter?: 'NONE' | 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL';
    };
  };
}
export interface TextureInfo {
  index: number;
  texCoord?: number;
  extensions?: {
    KHR_texture_transform?: {
      offset?: number[];
      rotation?: number;
      scale?: number[];
      texCoord?: number;
    };
    [name: string]: unknown;
  };
}
export interface Material {
  /** Engine-authored presentation policy, independent of standard glTF PBR data. */
  extras?: {
    engine?: {
      toon?: {
        threshold?: number;
        softness?: number;
        shadowLevel?: number;
        shadowColor?: number[];
        indirectStrength?: number;
        outlineColor?: number[];
        outlineWidth?: number;
      };
    };
  };
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
  extensions?: {
    KHR_materials_unlit?: Record<string, unknown>;
    KHR_materials_emissive_strength?: { emissiveStrength?: number };
    KHR_materials_ior?: { ior?: number };
    KHR_materials_specular?: {
      specularFactor?: number;
      specularTexture?: TextureInfo;
      specularColorFactor?: number[];
      specularColorTexture?: TextureInfo;
    };
    KHR_materials_clearcoat?: {
      clearcoatFactor?: number;
      clearcoatTexture?: TextureInfo;
      clearcoatRoughnessFactor?: number;
      clearcoatRoughnessTexture?: TextureInfo;
      clearcoatNormalTexture?: TextureInfo & { scale?: number };
    };
    KHR_materials_transmission?: { transmissionFactor?: number; transmissionTexture?: TextureInfo };
    KHR_materials_volume?: {
      thicknessFactor?: number;
      thicknessTexture?: TextureInfo;
      attenuationDistance?: number;
      attenuationColor?: number[];
    };
    [name: string]: unknown;
  };
}
export interface Gltf {
  asset: { version: string; minVersion?: string };
  extensions?: { KHR_lights_punctual?: { lights: PunctualLight[] } };
  buffers?: {
    uri?: string;
    byteLength: number;
    extensions?: { EXT_meshopt_compression?: { fallback?: boolean } };
  }[];
  bufferViews?: BufferView[];
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
    extensions?: { KHR_lights_punctual?: { light: number } };
  }[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  materials?: Material[];
  textures?: {
    source?: number;
    sampler?: number;
    extensions?: { KHR_texture_basisu?: { source: number } };
  }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }[];
  extensionsRequired?: string[];
  extensionsUsed?: string[];
  skins?: { joints: number[]; inverseBindMatrices?: number; skeleton?: number }[];
  animations?: Animation[];
}
export interface PunctualLight {
  name?: string;
  type: 'directional' | 'point' | 'spot';
  color?: number[];
  intensity?: number;
  range?: number;
  spot?: { innerConeAngle?: number; outerConeAngle?: number };
}
export interface Animation {
  /** Project metadata; glTF extras remain optional and do not change the format. */
  extras?: { engine?: { events?: { time: number; name: string }[] } };
  name?: string;
  samplers: { input: number; output: number; interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE' }[];
  channels: {
    sampler: number;
    target: { node?: number; path: 'translation' | 'rotation' | 'scale' | 'weights' };
  }[];
}
export interface Asset {
  /** Resolved CPU policy travels with decoded data to later accessor consumers. */
  limits?: Readonly<import('./limits').AssetLimits>;
  gltf: Gltf;
  buffers: ArrayBuffer[];
  images: Blob[];
  /** KTX2 pixel/block payloads; authored mip levels remain intact. */
  decodedImages?: Map<number, DecodedImage>;
  warnings: string[];
}
export interface DecodedImage {
  /** Missing format denotes legacy RGBA8. Transfer function comes from the material slot. */
  format?: import('./compression/textures').ImageFormat;
  /** Capabilities used for target selection, including deliberate RGBA fallbacks. */
  transcodedFor?: readonly import('./compression/textures').TextureCompression[];
  levels: { width: number; height: number; data: Uint8Array<ArrayBuffer> }[];
}
