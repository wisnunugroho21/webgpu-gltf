import { FollowCamera } from '../engine/camera/follow-camera';
import type { EngineFrame } from '../engine/runtime/types';
import type { World } from '../engine/world';
import type { Renderer } from '../renderer/renderer';
import type { CharacterSimulation } from './simulation';
import type { GameTools } from './tools';

/** Presentation consumes evaluated world state. Camera, audio/tooling and explicit
 * rendering remain application policy, outside physics and renderer scheduling. */
export class GamePresentation {
  readonly camera = new FollowCamera();
  tools?: GameTools;
  private lastTimestamp?: number;
  constructor(
    private world: World,
    private simulation: CharacterSimulation,
    private renderer: Renderer,
    private status: HTMLElement,
  ) {}
  present(frame: EngineFrame): void {
    const player = this.world.getEntity('player');
    // Companion events have no gameplay consumer; don't retain their queues forever.
    for (const model of this.world.modelInstances)
      if (model !== player.model) model.animation.drainEvents();
    const p = player.worldMatrix;
    const dt =
      this.lastTimestamp === undefined
        ? 0
        : Math.max(0, (frame.presentationTimeMs - this.lastTimestamp) / 1000);
    this.lastTimestamp = frame.presentationTimeMs;
    this.camera.update([p[12], p[13] + 1, p[14]], dt);
    this.tools?.update(this.camera);
    if (
      !this.renderer.render(frame.presentationTimeMs, this.camera.view(this.renderer.aspectRatio))
    )
      return;
    this.status.textContent = frame.paused
      ? 'Paused'
      : `${this.simulation.locomotion.state} · ${this.simulation.body.grounded ? 'Grounded' : 'Airborne'} · ${this.simulation.footfalls} footfalls`;
  }
}
