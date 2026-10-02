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
        // Pixel-expanded shells extend beyond geometry AABBs. Conservatively keep
        // outlined receivers until expanded screen bounds are implemented. Never
        // apply an unexpanded occlusion/scale/frustum result to their silhouettes.
        const outlined = !!draw.outlinePipeline;
        if (!outlined && enabled && !this.frustum.intersects(bounds)) continue;
        const first = draw.firstInstance + i;
        const occlusion = outlined ? undefined : filters?.occlusion;
        // Cached hidden results are valid only after dependency checks in beginFrame.
        // Skip repeated projections of stable instances and futile moving-depth queries.
        if (occlusion?.hasResult(first) && !occlusion.visible(first)) continue;
        const query = occlusion?.acceptingQueries && !occlusion.hasResult(first);
        const projected =
          !outlined && filters && (filters.minPixels > 0 || query)
            ? projectBounds(bounds, viewProjection, filters.width, filters.height)
            : undefined;
        if (projected && projected.pixels < filters!.minPixels) continue;
        // Changed geometry invalidates its history before visibility. New query
        // rectangles and near-plane/invalid bounds always fail open until delivery.
        if (projected && query) {
          occlusion!.add(first, projected);
        }
        const runs = draw.visibleRuns;
        if (runs.length && runs[runs.length - 2] + runs[runs.length - 1] === first)
          runs[runs.length - 1]++;
        else runs.push(first, 1);
      }
      stats.draws += (draw.visibleRuns.length / 2) * (draw.outlinePipeline ? 2 : 1);
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
