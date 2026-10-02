/** Renderer-independent transform address allocation. Handles are immutable and
 * never recycled within one attachment, even when a removed range is reused. */
export interface RenderInstanceHandle {
  readonly id: number;
  readonly firstInstance: number;
  readonly count: number;
}

export class InstanceSlots {
  private nextId = 1;
  private end = 0;
  private live = new Map<number, RenderInstanceHandle>();
  private free: { start: number; count: number }[] = [];
  get requiredCapacity(): number {
    return this.end;
  }
  clone(): InstanceSlots {
    const copy = new InstanceSlots();
    copy.nextId = this.nextId;
    copy.end = this.end;
    copy.live = new Map(this.live);
    copy.free = this.free.map((range) => ({ ...range }));
    return copy;
  }
  allocate(count: number): RenderInstanceHandle {
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('Invalid instance range size.');
    const index = this.free.findIndex((range) => range.count >= count);
    let firstInstance = this.end;
    if (index >= 0) {
      const range = this.free[index];
      firstInstance = range.start;
      range.start += count;
      range.count -= count;
      if (!range.count) this.free.splice(index, 1);
    } else {
      if (!Number.isSafeInteger(this.end + count))
        throw new Error('Instance range exceeds safe address limits.');
      this.end += count;
    }
    const handle = Object.freeze({ id: this.nextId++, firstInstance, count });
    this.live.set(handle.id, handle);
    return handle;
  }
  release(handle: RenderInstanceHandle): void {
    if (this.live.get(handle.id) !== handle) throw new Error('Stale render instance handle.');
    this.live.delete(handle.id);
    this.free.push({ start: handle.firstInstance, count: handle.count });
    this.free.sort((a, b) => a.start - b.start);
    const merged: typeof this.free = [];
    for (const range of this.free) {
      const previous = merged.at(-1);
      if (previous && previous.start + previous.count === range.start)
        previous.count += range.count;
      else merged.push({ ...range });
    }
    const tail = merged.at(-1);
    if (tail && tail.start + tail.count === this.end) {
      this.end = tail.start;
      merged.pop();
    }
    this.free = merged;
  }
}
