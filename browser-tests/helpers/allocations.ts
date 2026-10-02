/** Tracks requested resources after installation, excluding renderer startup and
 * swapchain images. Texture sizes are payload estimates, not driver VRAM usage. */
export function trackAllocations(device: GPUDevice) {
  let buffers = 0,
    textures = 0,
    liveBytes = 0,
    peakBytes = 0,
    requestedBytes = 0;
  const buffer = device.createBuffer.bind(device);
  const texture = device.createTexture.bind(device);
  const watch = <T extends GPUBuffer | GPUTexture>(resource: T, bytes: number): T => {
    liveBytes += bytes;
    requestedBytes += bytes;
    peakBytes = Math.max(peakBytes, liveBytes);
    const destroy = resource.destroy.bind(resource);
    let alive = true;
    resource.destroy = () => {
      if (alive) {
        liveBytes -= bytes;
        alive = false;
      }
      destroy();
    };
    return resource;
  };
  device.createBuffer = (descriptor) => {
    const resource = buffer(descriptor);
    buffers++;
    return watch(resource, resource.size);
  };
  device.createTexture = (descriptor) => {
    const bytesPerPixel: Partial<Record<GPUTextureFormat, number>> = {
      rgba8unorm: 4,
      'rgba8unorm-srgb': 4,
      bgra8unorm: 4,
      'bgra8unorm-srgb': 4,
      rgba16float: 8,
      rgba32float: 16,
      r16float: 2,
      rg16float: 4,
      depth32float: 4,
      depth24plus: 4,
    };
    const stride = bytesPerPixel[descriptor.format];
    // Fail instead of silently undercounting if a future workload adds a format.
    if (stride === undefined) throw new Error(`Unmeasured texture format: ${descriptor.format}`);
    const size = descriptor.size;
    const extent =
      Symbol.iterator in Object(size) ? Array.from(size as Iterable<number>) : undefined;
    const dimensions = size as GPUExtent3DDict;
    const width = extent?.[0] ?? dimensions.width;
    const height = extent?.[1] ?? dimensions.height ?? 1;
    const layers = extent?.[2] ?? dimensions.depthOrArrayLayers ?? 1;
    let bytes = 0;
    for (let mip = 0; mip < (descriptor.mipLevelCount ?? 1); mip++)
      bytes +=
        Math.max(1, Math.floor(width / 2 ** mip)) *
        Math.max(1, Math.floor(height / 2 ** mip)) *
        (descriptor.dimension === '3d' ? Math.max(1, Math.floor(layers / 2 ** mip)) : layers) *
        stride *
        (descriptor.sampleCount ?? 1);
    const resource = texture(descriptor);
    textures++;
    return watch(resource, bytes);
  };
  return {
    snapshot: () => ({ buffers, textures, liveBytes, peakBytes, requestedBytes }),
    restore: () => {
      device.createBuffer = buffer;
      device.createTexture = texture;
    },
  };
}
