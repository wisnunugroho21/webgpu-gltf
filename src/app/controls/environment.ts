import type { Renderer } from '../../renderer/renderer';
import {
  loadEnvironmentImage,
  studioEnvironment,
  type EnvironmentImage,
} from '../../renderer/lighting/source';
import { element } from '../dom';

export type EnvironmentSource = () => Promise<EnvironmentImage> | EnvironmentImage;

export function bindEnvironmentControls(
  renderer: Renderer,
  show: (source: EnvironmentSource, name: string) => Promise<void>,
): void {
  const update = () => {
    const intensity = Number(element<HTMLInputElement>('environment-intensity').value);
    const degrees = Number(element<HTMLInputElement>('environment-rotation').value);
    renderer.setEnvironment({ intensity, rotation: (degrees * Math.PI) / 180 });
    element('environment-intensity-value').textContent = intensity.toFixed(1);
    element('environment-rotation-value').textContent = `${degrees}°`;
  };
  element('environment-intensity').addEventListener('input', update);
  element('environment-rotation').addEventListener('input', update);
  element('environment-studio').addEventListener('click', () => {
    void show(studioEnvironment, 'Studio environment');
  });
  element<HTMLInputElement>('environment-file').addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void show(() => loadEnvironmentImage(file), file.name);
    input.value = '';
  });
}
