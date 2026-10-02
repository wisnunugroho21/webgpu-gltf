import type { AnimationController } from '../animation/controller';
import type { ActionState } from '../engine/input/actions';

/** Character policy is game code, not a renderer feature. Only state transitions
 * start fades; selecting every frame would continually reset the clip clock. */
export class Locomotion {
  state: 'Idle' | 'Walk' | 'Run' = 'Idle';
  constructor(private animation: AnimationController) {
    animation.select(0);
  }
  update(speed: number): void {
    const next = speed < 0.01 ? 'Idle' : speed > 3 ? 'Run' : 'Walk';
    if (next === this.state) return;
    this.state = next;
    this.animation.crossFadeTo(['Idle', 'Walk', 'Run'].indexOf(next), 0.18);
  }
}

export function movement(actions: ReadonlyMap<string, ActionState>) {
  const held = (name: string) => Number(actions.get(name)?.held ?? false);
  let x = held('right') - held('left'),
    z = held('back') - held('forward');
  const length = Math.hypot(x, z),
    speed = held('run') ? 5 : 2.5;
  if (length > 0) {
    x = (x / length) * speed;
    z = (z / length) * speed;
  }
  return { x, z, jump: actions.get('jump')?.pressed ?? false };
}
