import { AssetBudget, AssetValidationError, checkLimit } from './limits';

/** Read streams incrementally: Content-Length is only an early hint, never the
 * authority. Unknown/lying lengths still stop before retaining another chunk. */
export async function fetchAssetBytes(
  url: string,
  budget: AssetBudget,
  path: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  // Bound data URI text before asking the browser to expand its encoded payload.
  if (url.startsWith('data:'))
    budget.at(path, () =>
      checkLimit(url.length, budget.limits.maxResourceBytes * 4 + 1024, 'data URI length'),
    );
  const response = await fetch(url, { signal }).catch((error) => {
    signal?.throwIfAborted();
    throw new AssetValidationError(
      budget.source,
      path,
      `Could not fetch ${url}: ${String(error)}`,
      error,
    );
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new AssetValidationError(budget.source, path, `HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  try {
    const hint = response.headers.get('content-length');
    if (hint !== null)
      budget.at(path, () =>
        checkLimit(Number(hint), budget.limits.maxResourceBytes, 'Content-Length'),
      );
    if (!reader) {
      const bytes = await response.arrayBuffer();
      signal?.throwIfAborted();
      budget.bytes(bytes.byteLength, path);
      return bytes;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      budget.at(path, () =>
        checkLimit(size + value.byteLength, budget.limits.maxResourceBytes, 'resource bytes'),
      );
      budget.bytes(value.byteLength, path);
      size += value.byteLength;
      chunks.push(value);
    }
    signal?.throwIfAborted();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  } catch (error) {
    await reader?.cancel().catch(() => {});
    signal?.throwIfAborted();
    return budget.at(path, () => {
      throw error;
    });
  } finally {
    reader?.releaseLock();
  }
}
export async function readAssetFile(
  file: File,
  budget: AssetBudget,
  path: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  budget.bytes(file.size, path);
  const bytes = await file.arrayBuffer().catch((error) =>
    budget.at(path, () => {
      throw error;
    }),
  );
  signal?.throwIfAborted();
  return bytes;
}
