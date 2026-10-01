import { Frustum, visibleInstanceRuns } from './frustum';
import type { Scene, FrameStats } from './types';

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
  ): void {
    this.frustum.update(viewProjection);
    for (const draw of scene.draws) {
      visibleInstanceRuns(this.frustum, draw.bounds, draw.firstInstance, draw.visibleRuns, enabled);
      stats.draws += draw.visibleRuns.length / 2;
      for (let i = 1; i < draw.visibleRuns.length; i += 2) stats.instances += draw.visibleRuns[i];
    }
    stats.culledInstances = scene.stats.instances - stats.instances;
    scene.visibleTransparent.length = 0;
    for (const draw of scene.transparent)
      if (draw.visibleRuns.length) scene.visibleTransparent.push(draw);
  }
}
