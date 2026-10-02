import type { Gltf } from '../types';
import { AssetBudget, checkLimit } from '../limits';
import { components } from '../accessors';
import { array, object, ref } from './fields';

/** Count expanded channel data, not only unique samplers: several channels can
 * share keys but prepare separate arrays in the current playback implementation. */
export function validateAnimationMetadata(gltf: Gltf, budget: AssetBudget, values: number): void {
  let channels = 0,
    keys = 0;
  for (const [i, animation] of (gltf.animations ?? []).entries())
    budget.at(`animations[${i}]`, () => {
      array(animation.samplers);
      array(animation.channels);
      channels += animation.channels.length;
      for (const sampler of animation.samplers) {
        object(sampler);
        ref(sampler.input, gltf.accessors);
        ref(sampler.output, gltf.accessors);

        if (
          sampler.interpolation !== undefined &&
          !['LINEAR', 'STEP', 'CUBICSPLINE'].includes(sampler.interpolation)
        )
          throw new Error('Invalid animation interpolation.');
      }
      const targets = new Set<string>();
      for (const channel of animation.channels) {
        object(channel);
        object(channel.target);
        ref(channel.sampler, animation.samplers);
        ref(channel.target.node, gltf.nodes);
        if (!['translation', 'rotation', 'scale', 'weights'].includes(channel.target.path))
          throw new Error('Invalid animation target path.');
        const key = `${channel.target.node}/${channel.target.path}`;
        if (targets.has(key)) throw new Error('Duplicate animation target.');
        targets.add(key);
        const input = gltf.accessors![animation.samplers[channel.sampler].input];
        const output = gltf.accessors![animation.samplers[channel.sampler].output];
        const path = channel.target.path,
          node = gltf.nodes![channel.target.node!];
        const width =
          path === 'weights'
            ? gltf.meshes?.[node.mesh!]?.primitives[0]?.targets?.length
            : path === 'rotation'
              ? 4
              : 3;
        const factor = animation.samplers[channel.sampler].interpolation === 'CUBICSPLINE' ? 3 : 1;
        keys += input.count;
        values += input.count + output.count * components[output.type];
        checkLimit(
          values,
          budget.limits.maxTotalAccessorValues,
          'accessor and prepared animation values',
        );
        if (
          !width ||
          input.type !== 'SCALAR' ||
          input.componentType !== 5126 ||
          input.normalized ||
          output.type !== (path === 'weights' ? 'SCALAR' : path === 'rotation' ? 'VEC4' : 'VEC3') ||
          output.count * components[output.type] !== input.count * width * factor ||
          (path !== 'weights' && node.matrix)
        )
          throw new Error('Animation sampler shape does not match target.');
      }
      if (animation.extras?.engine?.events !== undefined) {
        array(animation.extras.engine.events);
        checkLimit(
          animation.extras.engine.events.length,
          budget.limits.maxAnimationChannels,
          'animation events',
        );
        for (const event of animation.extras.engine.events) object(event);
      }
    });
  budget.at('animations', () => {
    checkLimit(channels, budget.limits.maxAnimationChannels, 'animation channels');
    checkLimit(keys, budget.limits.maxAnimationKeys, 'animation keys');
  });
}
