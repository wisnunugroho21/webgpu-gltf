import { Frustum } from './frustum';
import type { Scene, FrameStats } from './types';
import { projectBounds } from './projected-bounds';
import type { OcclusionCulling } from './occlusion';

/** CPU visibility never controls pose or deformation updates. */
export class SceneVisibility {
  private frustum = new Frustum();
  /** Visibility consumes already updated pose bounds and the current camera matrix.
   * It never suppresses pose uploads/compute, so offscreen animation stays current. */
  update(
    scene: Scene,
    viewProjection: ArrayLike<number>,
    enabled: boolean,
    stats: FrameStats,
    filters?: { width: number; height: number; minPixels: number; occlusion?: OcclusionCulling },
  ): void {
    this.frustum.update(viewProjection);
    for (const draw of scene.draws) {
      draw.visibleRuns.length = 0;
      for (let i = 0; i < draw.bounds.length; i++) {
        const bounds = draw.bounds[i];
        if (enabled && !this.frustum.intersects(bounds)) continue;
        const projected =
          filters && (filters.minPixels > 0 || filters.occlusion)
            ? projectBounds(bounds, viewProjection, filters.width, filters.height)
            : undefined;
        if (projected && projected.pixels < filters!.minPixels) continue;
        const first = draw.firstInstance + i;
        // Query even previously hidden instances so objects can become visible again.
        // Near-plane/invalid bounds fail open for both optional filters.
        if (projected && filters?.occlusion) {
          filters.occlusion.add(first, projected);
          if (!filters.occlusion.visible(first)) continue;
        }
        const runs = draw.visibleRuns;
        if (runs.length && runs[runs.length - 2] + runs[runs.length - 1] === first)
          runs[runs.length - 1]++;
        else runs.push(first, 1);
      }
      stats.draws += draw.visibleRuns.length / 2;
      for (let i = 1; i < draw.visibleRuns.length; i += 2) stats.instances += draw.visibleRuns[i];
    }
    stats.culledInstances = scene.stats.instances - stats.instances;
    scene.visibleTransparent.length = 0;
    for (const draw of scene.transparent)
      if (draw.visibleRuns.length) scene.visibleTransparent.push(draw);
    scene.visibleTransmission.length = 0;
    for (const draw of scene.transmission)
      if (draw.visibleRuns.length) scene.visibleTransmission.push(draw);
  }
}
