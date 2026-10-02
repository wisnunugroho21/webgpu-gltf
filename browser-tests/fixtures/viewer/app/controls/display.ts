import type { Renderer } from '../../../../../src/renderer/renderer';
import type { ToneMapping } from '../../../../../src/renderer/presentation/output';
import { element } from '../dom';

export function bindDisplayControls(renderer: Renderer): void {
  const update = () => {
    const exposureEV = Number(element<HTMLInputElement>('exposure').value);
    renderer.setOutput({
      exposureEV,
      toneMapping: element<HTMLSelectElement>('tone-mapping').value as ToneMapping,
    });
    element('exposure-value').textContent = `${exposureEV.toFixed(1)} EV`;
  };
  element('tone-mapping').addEventListener('change', update);
  element('exposure').addEventListener('input', update);
  const shadows = element<HTMLInputElement>('shadows');
  shadows.checked = renderer.shadowSettings.enabled;
  shadows.addEventListener('change', () => renderer.setShadows({ enabled: shadows.checked }));
  const occlusion = element<HTMLInputElement>('occlusion-culling');
  occlusion.checked = renderer.occlusionCulling;
  occlusion.addEventListener('change', () => renderer.setOcclusionCulling(occlusion.checked));
  const scale = element<HTMLInputElement>('scale-culling');
  scale.value = String(renderer.scaleCulling);
  scale.addEventListener('input', () => {
    if (scale.value !== '' && scale.validity.valid) renderer.setScaleCulling(Number(scale.value));
  });
}
