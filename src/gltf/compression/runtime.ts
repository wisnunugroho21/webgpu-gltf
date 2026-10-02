import dracoScript from '../../../node_modules/three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?url';
import dracoWasm from '../../../node_modules/three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url';
import basisScript from '../../../node_modules/three/examples/jsm/libs/basis/basis_transcoder.js?url';
import basisWasm from '../../../node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm?url';
import type { DecodedImage } from '../types';
import { basisTargets, type TextureCompression } from './textures';
import { assetLimits, type AssetLimits } from '../limits';

export interface DracoAttribute {
  id: number;
  componentType: number;
  count: number;
  width: number;
}
export interface DracoResult {
  attributes: Record<string, ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
}

/** This function becomes a classic worker so the upstream Emscripten wrappers can use
 * importScripts. All third-party `any` values stay inside this WASM boundary. No renderer
 * or Three.js engine code is imported; the package supplies only the decoder artifacts. */
function decoderWorker() {
  const scope = self as any;
  const modules = new Map<string, Promise<any>>();
  async function module(kind: string, script: string, wasm: string) {
    let result = modules.get(kind);
    if (!result) {
      result = (async () => {
        scope.importScripts(script);
        const response = await fetch(wasm);
        if (!response.ok) throw new Error(`Could not load ${kind} WASM: HTTP ${response.status}`);
        const factory = kind === 'draco' ? scope.DracoDecoderModule : scope.BASIS;
        const value = await factory({ wasmBinary: await response.arrayBuffer() });
        if (kind === 'basis') value.initializeBasis();
        return value;
      })();
      modules.set(kind, result);
    }
    return result;
  }
  scope.onmessage = async (event: MessageEvent) => {
    const { id, kind, script, wasm, bytes, attributes, targets, support, limits, maxIndices } =
      event.data;
    try {
      const lib = await module(kind, script, wasm);
      if (kind === 'basis') {
        const file = new lib.KTX2File(new Uint8Array(bytes));
        try {
          if (
            !file.isValid() ||
            (!file.isETC1S() && !file.isUASTC()) ||
            file.getFaces() !== 1 ||
            file.getLayers() > 1
          )
            throw new Error('Only 2D ETC1S/UASTC Basis KTX2 textures are supported.');
          const baseWidth = file.getWidth(),
            baseHeight = file.getHeight(),
            levelCount = file.getLevels();
          if (
            !Number.isSafeInteger(baseWidth) ||
            !Number.isSafeInteger(baseHeight) ||
            baseWidth < 1 ||
            baseHeight < 1 ||
            baseWidth > limits.maxImageDimension ||
            baseHeight > limits.maxImageDimension ||
            baseWidth * baseHeight > limits.maxImagePixels ||
            levelCount < 1 ||
            levelCount > 1 + Math.floor(Math.log2(Math.max(baseWidth, baseHeight)))
          )
            throw new Error('KTX2 image exceeds CPU limits.');
          if (!file.startTranscoding()) throw new Error('Could not start Basis transcode.');
          const levels = [];
          // WebGPU compressed base sizes must be block-aligned. A single-level
          // image uses RGBA so the existing render-based mip generator still works.
          const compressed =
            file.getWidth() % 4 === 0 && file.getHeight() % 4 === 0 && file.getLevels() > 1;
          const target = targets.find(
            (target: { format: string; uastcOnly?: boolean }) =>
              (target.format === 'rgba8' || compressed) && (!target.uastcOnly || file.isUASTC()),
          );
          if (!target) throw new Error('No supported Basis transcode target.');
          for (let mip = 0; mip < file.getLevels(); mip++) {
            const info = file.getImageLevelInfo(mip, 0, 0);
            const width = info.origWidth,
              height = info.origHeight;
            if (
              width !== Math.max(1, baseWidth >> mip) ||
              height !== Math.max(1, baseHeight >> mip)
            )
              throw new Error('Invalid KTX2 image dimensions.');
            // Transcode directly into retained GPU blocks. Slot formats decide sRGB
            // versus linear interpretation; container transfer metadata never does.
            const expected =
              target.format === 'rgba8'
                ? width * height * 4
                : Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
            const size = file.getImageTranscodedSizeInBytes(mip, 0, 0, target.transcoder);
            if (!Number.isSafeInteger(size) || size !== expected)
              throw new Error('Invalid KTX2 transcode size.');
            const data = new Uint8Array(size);
            if (
              !file.transcodeImage(data, mip, 0, 0, target.transcoder, 0, -1, -1) ||
              data.byteLength !== expected
            )
              throw new Error(`Could not transcode KTX2 mip ${mip}.`);
            levels.push({ width, height, data });
          }
          if (!levels.length) throw new Error('KTX2 has no mip levels.');
          scope.postMessage(
            { id, result: { format: target.format, transcodedFor: support, levels } },
            levels.map((level) => level.data.buffer),
          );
        } finally {
          file.close();
          file.delete();
        }
      } else {
        const decoder = new lib.Decoder();
        const mesh = new lib.Mesh();
        try {
          const input = new Int8Array(bytes);
          if (decoder.GetEncodedGeometryType(input) !== lib.TRIANGULAR_MESH)
            throw new Error('Draco glTF primitive must contain a triangle mesh.');
          const status = decoder.DecodeArrayToMesh(input, input.byteLength, mesh);
          if (!status.ok() || !mesh.ptr)
            throw new Error(`Draco decode failed: ${status.error_msg()}`);
          const indexCount = mesh.num_faces() * 3;
          if (
            !Number.isSafeInteger(indexCount) ||
            indexCount < 1 ||
            indexCount > maxIndices ||
            indexCount > limits.maxAccessorValues
          )
            throw new Error('Draco index count exceeds declared CPU limit.');
          const output: Record<string, ArrayBuffer> = {};
          const types: Record<number, [any, string]> = {
            5120: [Int8Array, 'DT_INT8'],
            5121: [Uint8Array, 'DT_UINT8'],
            5122: [Int16Array, 'DT_INT16'],
            5123: [Uint16Array, 'DT_UINT16'],
            5125: [Uint32Array, 'DT_UINT32'],
            5126: [Float32Array, 'DT_FLOAT32'],
          };
          for (const [name, config] of Object.entries(
            attributes as Record<string, DracoAttribute>,
          )) {
            const attribute = decoder.GetAttributeByUniqueId(mesh, config.id);
            const type = types[config.componentType];
            if (
              !attribute?.ptr ||
              !type ||
              config.count !== mesh.num_points() ||
              config.width !== attribute.num_components()
            )
              throw new Error(`Draco ${name} does not match its accessor.`);
            const length = config.count * config.width;
            if (!Number.isSafeInteger(length) || length > limits.maxAccessorValues)
              throw new Error('Draco attribute exceeds CPU limits.');
            const size = length * type[0].BYTES_PER_ELEMENT;
            const pointer = lib._malloc(size);
            try {
              if (
                !decoder.GetAttributeDataArrayForAllPoints(
                  mesh,
                  attribute,
                  lib[type[1]],
                  size,
                  pointer,
                )
              )
                throw new Error(`Could not decode Draco ${name}.`);
              output[name] = new type[0](lib.HEAPU8.buffer, pointer, length).slice().buffer;
            } finally {
              lib._free(pointer);
            }
          }
          const length = mesh.num_faces() * 3;
          const pointer = lib._malloc(length * 4);
          let indices: Uint32Array;
          try {
            if (!decoder.GetTrianglesUInt32Array(mesh, length * 4, pointer))
              throw new Error('Could not decode Draco indices.');
            indices = new Uint32Array(lib.HEAPU8.buffer, pointer, length).slice();
          } finally {
            lib._free(pointer);
          }
          scope.postMessage({ id, result: { attributes: output, indices } }, [
            ...Object.values(output),
            indices.buffer,
          ]);
        } finally {
          lib.destroy(mesh);
          lib.destroy(decoder);
        }
      }
    } catch (error) {
      scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

/** One short-lived worker per load. Modules initialize lazily and are shared by all
 * primitives/images in that load; success and failure both terminate it. */
export class CompressionRuntime {
  private worker?: Worker;
  private nextId = 0;
  private disposed = false;
  private onAbort = () =>
    this.dispose(this.signal?.reason ?? new DOMException('Load canceled.', 'AbortError'));
  constructor(
    private limits: Readonly<AssetLimits> = assetLimits(),
    private signal?: AbortSignal,
  ) {
    signal?.addEventListener('abort', this.onAbort, { once: true });
  }
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private request<T>(
    kind: 'draco' | 'basis',
    bytes: ArrayBuffer,
    attributes?: Record<string, DracoAttribute>,
    support: readonly TextureCompression[] = [],
    maxIndices = this.limits.maxAccessorValues,
  ): Promise<T> {
    this.signal?.throwIfAborted();
    if (this.disposed) return Promise.reject(new Error('Compression runtime is disposed.'));
    if (!this.worker) {
      const url = URL.createObjectURL(
        new Blob([`(${decoderWorker.toString()})()`], { type: 'text/javascript' }),
      );
      try {
        this.worker = new Worker(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      this.worker.onmessage = ({ data }) => {
        const task = this.pending.get(data.id);
        if (!task) return;
        this.pending.delete(data.id);
        if (data.error) task.reject(new Error(data.error));
        else task.resolve(data.result);
      };
      this.worker.onerror = (event) =>
        this.dispose(new Error(`Compression worker failed: ${event.message}`));
    }
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) =>
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject }),
    );
    try {
      this.worker.postMessage(
        {
          id,
          kind,
          bytes,
          attributes,
          targets: basisTargets(support),
          support,
          limits: this.limits,
          maxIndices,
          script: new URL(kind === 'draco' ? dracoScript : basisScript, location.href).href,
          wasm: new URL(kind === 'draco' ? dracoWasm : basisWasm, location.href).href,
        },
        [bytes],
      );
    } catch (error) {
      const task = this.pending.get(id);
      this.pending.delete(id);
      task?.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }
  draco(
    bytes: ArrayBuffer,
    attributes: Record<string, DracoAttribute>,
    maxIndices = this.limits.maxAccessorValues,
  ) {
    return this.request<DracoResult>('draco', bytes, attributes, [], maxIndices);
  }
  basis(bytes: ArrayBuffer, support: readonly TextureCompression[] = []) {
    return this.request<DecodedImage>('basis', bytes, undefined, support);
  }
  dispose(error = new Error('Compression load ended.')) {
    this.disposed = true;
    this.signal?.removeEventListener('abort', this.onAbort);
    this.worker?.terminate();
    this.worker = undefined;
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
  }
}
