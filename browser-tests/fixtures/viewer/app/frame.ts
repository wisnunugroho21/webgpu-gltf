import type { Renderer } from '../../../../src/renderer/renderer';

/** Legacy viewer policy lives outside core rendering. Engine applications instead
 * evaluate their world/runtime and then call renderer.render with their own view. */
export function renderViewerFrame(renderer: Renderer, timestampMs: number): boolean {
  if (renderer.world) renderer.world.update(timestampMs);
  else renderer.animation.update(timestampMs);
  return renderer.render(timestampMs);
}
