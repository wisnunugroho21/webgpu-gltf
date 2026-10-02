/** One allocation owner for a scene or shared model; destruction also releases its leases. */
export class Resources {
  private readonly owned: (GPUBuffer | GPUTexture)[] = [];
  private readonly releases: (() => void)[] = [];
  /** Attach a shared-resource lease to this scene's transactional lifetime. */
  defer(release: () => void): void {
    this.releases.push(release);
  }
  own<T extends GPUBuffer | GPUTexture>(resource: T): T {
    this.owned.push(resource);
    return resource;
  }
  destroy(): void {
    for (const resource of this.owned) resource.destroy();
    this.owned.length = 0;
    for (const release of this.releases.splice(0)) release();
  }
}

/** Candidate and active scenes can overlap. Release shared allocations only after
 * the final scene lease ends; failed candidates cannot destroy an active model. */
export class ResourceCache<K, T> {
  private records = new Map<K, { value: Promise<T>; resources: Resources; users: number }>();
  acquire(key: K, owner: Resources, create: (resources: Resources) => Promise<T>): Promise<T> {
    let record = this.records.get(key);
    if (!record) {
      const resources = new Resources();
      // Defer creation until the record and its release hook are registered.
      const created = { resources, users: 0 };
      const value = Promise.resolve().then(async () => {
        try {
          return await create(resources);
        } finally {
          // An owner can be disposed while asynchronous preparation is pending.
          // Also release allocations created after that early disposal.
          if (!created.users) resources.destroy();
        }
      });
      record = Object.assign(created, { value });
      this.records.set(key, record);
    }
    const retained = record;
    retained.users++;
    owner.defer(() => {
      if (--retained.users === 0) {
        this.records.delete(key);
        retained.resources.destroy();
      }
    });
    return retained.value;
  }
}

/** Retain private instance or binding allocations across transactional scene shells.
 * Each candidate owns a lease; destroying a failed candidate releases only its lease. */
export class SharedResources {
  readonly resources = new Resources();
  private users = 0;
  private released = false;
  retain(owner: Resources): void {
    if (this.released) throw new Error('Cannot retain released resources.');
    this.users++;
    owner.defer(() => {
      if (--this.users === 0) {
        this.released = true;
        this.resources.destroy();
      }
    });
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
