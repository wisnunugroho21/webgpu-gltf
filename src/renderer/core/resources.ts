/** Scene ownership makes replacement and failed loads safe: destroy every allocation together. */
export class Resources {
  private readonly owned: (GPUBuffer | GPUTexture)[] = [];
  own<T extends GPUBuffer | GPUTexture>(resource: T): T {
    this.owned.push(resource);
    return resource;
  }
  destroy(): void {
    for (const resource of this.owned) resource.destroy();
    this.owned.length = 0;
  }
}

export function uploadBuffer(
  device: GPUDevice,
  resources: Resources,
  data: ArrayBufferView,
  usage: GPUBufferUsageFlags,
  label: string,
): GPUBuffer {
  // Mapping permits odd byte counts; GPU allocations must still be four-byte aligned.
  const buffer = resources.own(
    device.createBuffer({
      label,
      size: Math.max(4, Math.ceil(data.byteLength / 4) * 4),
      usage,
      mappedAtCreation: true,
    }),
  );
  new Uint8Array(buffer.getMappedRange()).set(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  );
  buffer.unmap();
  return buffer;
}
