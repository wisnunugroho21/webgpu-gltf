# Hierarchy primitives and validation ownership

Refactoring part 4 consolidates three duplicated operations without replacing the world or model hierarchy with a universal graph abstraction. Selection, topology validation, reachability, transform evaluation and transactional edits retain separate contracts.

| Primitive                                    | Consumers                                                                             | Contract                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gltf/hierarchy.ts` → `buildNodeForest()`    | CPU decoding metadata validation; `scene/Pose` construction                           | Validate every glTF node's child references and single-parent topology; reject disconnected cycles; produce a parent table and authored parent-first order |
| `gltf/hierarchy.ts` → `walkSelectedScene()`  | `selectedSceneNodes()` for light membership; `collectInstances()` for mesh membership | Traverse the selected scene in authored root/child order; reject invalid/repeated reachable nodes; carry caller-owned parent state                         |
| `scene/hierarchy.ts` → `descendantClosure()` | Sparse pose candidate expansion; entity subtree removal                               | Include seeds and reachable descendants once; tolerate overlaps and cycles; return a set without claiming parent-first ordering or validating topology     |

## Full glTF forest

`buildNodeForest()` uses an `Int32Array` parent table, with `-1` for roots, and an explicit stack to build preorder. Roots are visited in definition order and children in authored order. Child indices must be nonnegative safe integers referencing existing nodes. Repeated child links, including repeats under the same parent, violate the single-parent rule. With that rule established, a cycle is disconnected from every root; incomplete coverage rejects it. Validation and order construction are linear and do not consume the JavaScript call stack.

The primitive reports a small typed issue to a caller-supplied rejection function. CPU decoding supplies asset/path diagnostics through `AssetBudget`; a malformed link still identifies its owning `nodes[index].children`. Pose supplies its existing model-hierarchy error messages. Each caller receives its own topology arrays; this change adds no global cache or mutable state shared between instances.

The loader retains its separate scene-root rules: authored scenes require unique true roots, and every model node is validated before publication. Pose also validates all nodes, including unselected nodes. Pose owns rank construction, sampled locals, overrides, animation target classification and mutable world revisions. The helper evaluates no matrices and chooses no scene.

## Selected scene

`walkSelectedScene()` shares the exact membership walk between mesh collection and the node list used for authored lights. Explicit scene roots keep their authored order. Without authored scenes, roots are inferred from child references. An authored empty scene selects nothing; an invalid default scene still fails.

Only reachable nodes participate in this traversal's validation. Direct selection helpers do not become whole-model validators: unselected cycles or missing child references do not alter selection. Normal file/URL loading still rejects that malformed asset at its full-forest decoding boundary, and Pose construction independently rejects it. Likewise, global scene-root validation remains in metadata decoding rather than being inferred by the selected traversal.

The visitor returns state for its children. Mesh collection passes its newly accumulated world matrix, so sibling branches cannot overwrite one another's parent transform; it keeps ownership of inverse/normal matrices, singular-mesh policy and mirrored winding. Membership-only selection carries no transform state. Traversal allocates no full-model world-matrix cache and does not share transforms between different model instances.

## Descendants and entity ownership

`descendantClosure()` includes roots and descendants once using a set and an explicit stack. Overlapping roots are legitimate. It preserves the existing LIFO expansion behavior but is not a parent-first ordering API.

Pose expands current and outgoing TRS targets, merges that result with directly sampled targets and sorts candidates using its validated forest ranks. Weight-only tracks still update their target without expanding transform descendants. Outgoing targets still restore defaults before retirement. Sparse work lists remain cached until layer/override membership changes.

Entity subtree removal also needs overlap/cycle tolerance because an atomic structural batch can temporarily contain a cycle. Removal uses the candidate's current child adjacency and terminates before final validation/publication. A net no-op preserves the live hierarchy cache, identities and revisions. This reachability operation deliberately does not substitute for final entity-parent validation.

`engine/world/validation.ts` keeps string-ID parent-chain validation for scene documents, prefabs and structural batches. `EntityHierarchy` keeps single-edit ancestor validation, root/child adjacency, transactional cloning and its cached preorder with exclusive subtree ranges. `World` keeps dirty evaluation, numeric failure recovery and model-root synchronization. These responsibilities are different from an immutable indexed glTF forest and remain in their existing owners.

## Verification

`tests/hierarchy-primitives.test.ts` covers authored/root order, parents occurring after children, sibling matrix state and mirrored winding, invalid/repeated selected membership, unselected malformed topology, empty/default scene behavior, contextual diagnostics, singular-mesh policy, overlapping descendant seeds and staged-cycle deletion. A 25,000-node primitive test checks stack safety. Existing 10,000-node model and 25,000-entity world tests continue to cover deep evaluation, root overrides, destruction, dirty subtree skips and transactional rollback. Existing sparse-pose and GPU suites verify target retirement, transforms, lighting and deformation through the real consumers.

The primitives remain internal CPU modules. Public renderer/engine APIs and pose upload → compute → shadows → color → presentation phases are unchanged.

Verified locally on October 2, 2026: 252 CPU tests across 40 files, 86 offline WebGPU tests and four remote Khronos sample tests passed. Browser type checks, formatting, production build and production Draco/Basis plus playable WASM startup also passed. The remote samples include DamagedHelmet, ChronographWatch, SimpleSkin and AnimatedMorphCube.
