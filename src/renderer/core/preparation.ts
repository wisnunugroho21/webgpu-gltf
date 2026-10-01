// Error scopes form a stack on the device, not on a renderer/scene/environment.
// Serialize preparation across owners sharing a device so asynchronous loads cannot
// pop each other's scopes, or let a slow older request replace a newer request.
const tails = new WeakMap<GPUDevice, Promise<void>>();

/** Prepare and validate a candidate, then commit synchronously in request order.
 * The caller owns candidate allocations and cleans them up if preparation fails.
 * Rejections do not poison the queue; separate devices prepare independently. */
export function prepareGpu<T, R>(
  device: GPUDevice,
  prepare: () => Promise<T>,
  commit: (candidate: T) => R,
): Promise<R> {
  const operation = (tails.get(device) ?? Promise.resolve()).then(async () => {
    device.pushErrorScope('validation');
    let candidate: T | undefined;
    let failed = false;
    let failure: unknown;
    try {
      candidate = await prepare();
    } catch (error) {
      failed = true;
      failure = error;
    }
    // Pop even when CPU preparation failed, preserving its more useful diagnostic.
    let gpuError: GPUError | null;
    try {
      gpuError = await device.popErrorScope();
    } catch (error) {
      throw failed ? failure : error;
    }
    if (failed) throw failure;
    if (gpuError) throw new Error(gpuError.message);
    return commit(candidate as T);
  });
  tails.set(
    device,
    operation.then(
      () => undefined,
      () => undefined,
    ),
  );
  return operation;
}
