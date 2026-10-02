import type { Gltf } from '../types';
import { AssetBudget, checkLimit } from '../limits';
import { components } from '../accessors';
import { quantizedAttribute } from '../quantization';
import { array, object, ref, vector, integer } from './fields';

export function validateSceneMetadata(gltf: Gltf, budget: AssetBudget): number {
  let primitiveCount = 0,
    expandedValues = 0;
  for (const [i, mesh] of (gltf.meshes ?? []).entries())
    budget.at(`meshes[${i}]`, () => {
      array(mesh.primitives);
      if (!mesh.primitives.length) throw new Error('Mesh requires primitives.');
      primitiveCount += mesh.primitives.length;
      const targetCount = mesh.primitives[0]?.targets?.length ?? 0;
      if (mesh.weights !== undefined) vector(mesh.weights, targetCount);
      for (const primitive of mesh.primitives) {
        if ((primitive.targets?.length ?? 0) !== targetCount)
          throw new Error('Mesh morph target counts differ.');
        object(primitive);
        object(primitive.attributes);
        ref(primitive.attributes.POSITION, gltf.accessors);
        const position = gltf.accessors![primitive.attributes.POSITION];
        if (
          position.type !== 'VEC3' ||
          (position.componentType !== 5126 && !quantizedAttribute(gltf, position))
        )
          throw new Error('POSITION requires VEC3.');
        for (const index of Object.values(primitive.attributes)) {
          ref(index, gltf.accessors);
          expandedValues += gltf.accessors![index].count * components[gltf.accessors![index].type];
          if (gltf.accessors![index].count !== position.count)
            throw new Error('Attribute count mismatch.');
        }
        for (const [name, index] of Object.entries(primitive.attributes)) {
          const a = gltf.accessors![index],
            width = components[a.type];
          if (
            (name === 'NORMAL' && width !== 3) ||
            (name === 'TANGENT' && width !== 4) ||
            (/^TEXCOORD_/.test(name) && width !== 2) ||
            (/^COLOR_/.test(name) && ![3, 4].includes(width))
          )
            throw new Error(`Invalid ${name} shape.`);
          if (
            /^JOINTS_/.test(name) &&
            (width !== 4 || a.normalized || ![5121, 5123].includes(a.componentType))
          )
            throw new Error('Invalid skin joint shape.');
          if (
            /^WEIGHTS_/.test(name) &&
            (width !== 4 ||
              !(
                a.componentType === 5126 ||
                ([5121, 5123].includes(a.componentType) && a.normalized)
              ))
          )
            throw new Error('Invalid skin weight shape.');
          if (/^JOINTS_/.test(name))
            ref(primitive.attributes[name.replace('JOINTS', 'WEIGHTS')], gltf.accessors);
          if (/^WEIGHTS_/.test(name))
            ref(primitive.attributes[name.replace('WEIGHTS', 'JOINTS')], gltf.accessors);
        }
        if (primitive.indices !== undefined) {
          ref(primitive.indices, gltf.accessors);
          const a = gltf.accessors![primitive.indices];
          if (a.type !== 'SCALAR' || a.normalized || ![5121, 5123, 5125].includes(a.componentType))
            throw new Error('Invalid index accessor.');
        }
        if (primitive.material !== undefined) ref(primitive.material, gltf.materials);
        if (
          primitive.mode !== undefined &&
          (!Number.isInteger(primitive.mode) || primitive.mode < 0 || primitive.mode > 6)
        )
          throw new Error('Invalid primitive mode.');
        if (primitive.targets !== undefined) {
          array(primitive.targets);
          if (primitive.targets.length !== targetCount)
            throw new Error('Mesh morph target counts differ.');
          checkLimit(primitive.targets.length, budget.limits.maxDefinitions, 'morph targets');
          for (const target of primitive.targets) {
            object(target);
            if (!Object.keys(target).length) throw new Error('Morph target requires attributes.');
            for (const [name, index] of Object.entries(target)) {
              ref(index, gltf.accessors);
              const a = gltf.accessors![index];
              expandedValues += a.count * components[a.type];
              if (
                !['POSITION', 'NORMAL', 'TANGENT'].includes(name) ||
                primitive.attributes[name] === undefined ||
                a.type !== 'VEC3' ||
                a.count !== position.count ||
                (a.componentType !== 5126 && !quantizedAttribute(gltf, a, true))
              )
                throw new Error('Invalid morph target shape or count.');
            }
          }
        }
        checkLimit(
          expandedValues,
          budget.limits.maxTotalAccessorValues,
          'expanded geometry values',
        );
        const draco = primitive.extensions?.KHR_draco_mesh_compression;
        if (draco) {
          object(draco);
          ref(draco.bufferView, gltf.bufferViews);
          object(draco.attributes);
          for (const [name, id] of Object.entries(draco.attributes)) {
            integer(id);
            ref(primitive.attributes[name], gltf.accessors);
          }
        }
      }
    });
  budget.at('meshes', () => checkLimit(primitiveCount, budget.limits.maxDefinitions, 'primitives'));
  const nodes = gltf.nodes ?? [],
    parents = new Int32Array(nodes.length).fill(-1);
  let poseValues = 0;
  for (const [i, node] of nodes.entries())
    budget.at(`nodes[${i}]`, () => {
      if (node.mesh !== undefined) ref(node.mesh, gltf.meshes);
      // Default morph weights are allocated per node even when omitted from JSON.
      poseValues += 10 + (gltf.meshes?.[node.mesh!]?.primitives[0]?.targets?.length ?? 0);
      checkLimit(poseValues, budget.limits.maxPoseValues, 'pose TRS/morph values');
      if (node.skin !== undefined) {
        ref(node.skin, gltf.skins);
        if (node.mesh === undefined) throw new Error('Skinned node requires a mesh.');
      }
      for (const [name, length] of [
        ['matrix', 16],
        ['translation', 3],
        ['rotation', 4],
        ['scale', 3],
      ] as const)
        if (node[name] !== undefined) vector(node[name], length);
      if (node.matrix && (node.translation || node.rotation || node.scale))
        throw new Error('Matrix and TRS are mutually exclusive.');
      if (node.rotation && Math.hypot(...node.rotation) < 1e-8)
        throw new Error('Zero-length rotation.');
      if (node.weights !== undefined)
        vector(node.weights, gltf.meshes?.[node.mesh!]?.primitives[0]?.targets?.length ?? 0);
      if (node.children !== undefined) {
        array(node.children);
        for (const child of node.children) {
          ref(child, nodes);
          if (parents[child] !== -1) throw new Error('Node has multiple parents.');
          parents[child] = i;
        }
      }
    });
  // Kahn traversal validates every node, including nodes outside the selected scene.
  const pending = nodes.map((_, i) => i).filter((i) => parents[i] === -1);
  let visited = 0;
  while (pending.length) {
    const index = pending.pop()!;
    visited++;
    for (const child of nodes[index].children ?? []) pending.push(child);
  }
  if (visited !== nodes.length)
    budget.at('nodes', () => {
      throw new Error('Node hierarchy contains a cycle.');
    });
  for (const [i, scene] of (gltf.scenes ?? []).entries())
    budget.at(`scenes[${i}].nodes`, () => {
      if (scene.nodes === undefined) return;
      array(scene.nodes);
      const seen = new Set<number>();
      for (const node of scene.nodes) {
        ref(node, nodes);
        if (parents[node] !== -1 || seen.has(node))
          throw new Error('Scene requires unique root nodes.');
        seen.add(node);
      }
    });
  if (gltf.scene !== undefined) budget.at('scene', () => ref(gltf.scene, gltf.scenes));
  for (const [i, skin] of (gltf.skins ?? []).entries())
    budget.at(`skins[${i}]`, () => {
      array(skin.joints);
      if (!skin.joints.length || new Set(skin.joints).size !== skin.joints.length)
        throw new Error('Skin requires unique joints.');
      for (const joint of skin.joints) ref(joint, nodes);
      if (skin.skeleton !== undefined) ref(skin.skeleton, nodes);
      if (skin.inverseBindMatrices !== undefined) {
        ref(skin.inverseBindMatrices, gltf.accessors);
        const a = gltf.accessors![skin.inverseBindMatrices];
        if (
          a.type !== 'MAT4' ||
          a.componentType !== 5126 ||
          a.count < skin.joints.length ||
          (a.bufferView === undefined && !a.sparse)
        )
          throw new Error('Invalid inverse bind matrices.');
      }
    });
  return expandedValues;
}
