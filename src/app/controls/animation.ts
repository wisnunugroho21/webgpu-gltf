import type { Renderer } from '../../renderer/renderer';
import { element } from '../dom';

/** Animation widgets only; playback policy remains in AnimationController. */
export class AnimationControls {
  constructor(
    private renderer: Renderer,
    private unavailable: () => boolean,
  ) {
    renderer.animation.onChange = () => this.update();
    element('animation-clip').addEventListener('change', () =>
      renderer.animation.select(Number(element<HTMLSelectElement>('animation-clip').value)),
    );
    element('animation-play').addEventListener('click', () =>
      renderer.animation.setPlaying(!renderer.animation.state.playing),
    );
    element('animation-restart').addEventListener('click', () => renderer.animation.seek(0));
    element('animation-time').addEventListener('input', () => {
      // Pausing synchronously refreshes the controls, so capture the requested time first.
      const time = Number(element<HTMLInputElement>('animation-time').value);
      renderer.animation.setPlaying(false);
      renderer.animation.seek(time);
    });
  }

  refreshClips(): void {
    element<HTMLSelectElement>('animation-clip').replaceChildren(
      new Option('Authored pose', '-1'),
      ...this.renderer.animation.state.clips.map((name, index) => new Option(name, String(index))),
    );
    this.update();
  }

  update(): void {
    const state = this.renderer.animation.state;
    element('animation-controls').hidden = !state.clips.length;
    element<HTMLSelectElement>('animation-clip').value = String(state.clip);
    const timeline = element<HTMLInputElement>('animation-time');
    timeline.max = String(state.duration);
    timeline.value = String(state.time);
    timeline.disabled = this.unavailable() || state.clip < 0 || state.duration === 0;
    element<HTMLButtonElement>('animation-play').disabled = this.unavailable() || state.clip < 0;
    element('animation-play').textContent = state.playing ? 'Pause' : 'Play';
    element('animation-clock').textContent =
      `${state.time.toFixed(2)} / ${state.duration.toFixed(2)} s`;
  }
}
