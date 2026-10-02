import type { ActionInput } from '../engine/input/actions';
import { bindKeyboard } from './keyboard';

export function gameElements(root: Document) {
  const required = <T extends Element>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing game element ${selector}.`);
    return element;
  };
  // Validate optional tooling's elements too, before allocating runtime resources.
  for (const id of ['save', 'load', 'audio', 'inspector', 'inspection']) required(`#${id}`);
  return {
    canvas: required<HTMLCanvasElement>('#game'),
    status: required<HTMLElement>('#status'),
    saveStatus: required<HTMLElement>('#save-status'),
    pause: required<HTMLButtonElement>('#pause'),
    companion: required<HTMLButtonElement>('#companion'),
    rootMotion: required<HTMLInputElement>('#root-motion'),
  };
}
export type GameElements = ReturnType<typeof gameElements>;
interface ControlActions {
  pause(): void;
  companion(): void;
  rootMotion(enabled: boolean): void;
  visibility(): void;
}

/** Browser bindings only. Register the owner before bind(), so a partial binding
 * failure can still abort listeners and clear keyboard state. */
export class GameControls {
  private events = new AbortController();
  private unbind = () => {};
  constructor(
    private view: GameElements,
    private input: ActionInput,
    private actions: ControlActions,
  ) {}
  bind(): void {
    this.unbind = bindKeyboard(this.input);
    const options = { signal: this.events.signal };
    const { canvas, pause, companion, rootMotion } = this.view;
    canvas.tabIndex = 0;
    canvas.addEventListener('pointerdown', () => canvas.focus(), options);
    pause.addEventListener(
      'click',
      () => {
        this.actions.pause();
        canvas.focus();
      },
      options,
    );
    companion.addEventListener('click', () => this.actions.companion(), options);
    rootMotion.addEventListener(
      'change',
      () => {
        this.actions.rootMotion(rootMotion.checked);
        this.input.clear();
        canvas.focus();
      },
      options,
    );
    document.addEventListener('visibilitychange', () => this.actions.visibility(), options);
  }
  update(paused: boolean, companion: boolean, disabled: boolean, busy = false): void {
    this.view.pause.textContent = paused ? 'Resume' : 'Pause';
    this.view.companion.textContent = companion ? 'Despawn companion' : 'Spawn companion';
    this.view.pause.disabled = disabled;
    this.view.companion.disabled = disabled || busy;
  }
  destroy(): void {
    this.events.abort();
    this.unbind();
  }
}
