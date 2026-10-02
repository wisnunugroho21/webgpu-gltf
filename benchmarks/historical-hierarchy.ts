import { mat4 } from 'gl-matrix';
import type { EntityDefinition } from '../src/engine/scene-document';
import { transformData } from '../src/scene/transform';

/** Test-only reference to the Phase 1 transform algorithm for CPU-only entities:
 * recursive ancestor visits, local reconstruction, copied parent matrices and
 * full matrix validation on every evaluation. Never imported by production. */
export class HistoricalHierarchy {
  private records;
  constructor(definitions: readonly EntityDefinition[]) {
    this.records = new Map(
      definitions.map((definition) => [
        definition.id,
        {
          parent: definition.parent,
          transform: transformData(definition.transform),
          world: mat4.create(),
          local: mat4.create(),
        },
      ]),
    );
  }
  setTranslation(id: string, translation: number[]): void {
    this.records.get(id)!.transform.translation = translation;
  }
  update(): number {
    const visited = new Set<string>();
    let matrices = 0;
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      const node = this.records.get(id)!;
      if (node.parent !== undefined) visit(node.parent);
      const { rotation, translation, scale } = node.transform;
      mat4.fromRotationTranslationScale(
        node.local,
        rotation as [number, number, number, number],
        translation as [number, number, number],
        scale as [number, number, number],
      );
      if (node.parent === undefined) mat4.copy(node.world, node.local);
      else mat4.multiply(node.world, mat4.clone(this.records.get(node.parent)!.world), node.local);
      if ([...node.world].some((value) => !Number.isFinite(value)))
        throw new Error('Invalid world matrix.');
      matrices++;
      visited.add(id);
    };
    for (const id of this.records.keys()) visit(id);
    return matrices;
  }
}
