/** Every invocation owns one output vertex. Separate immutable input and writable output
 * prevent races and cumulative deformation when the same pose is evaluated again. */
function shader(batched: boolean): string {
  return /* wgsl */ `
struct Vertex {
  position: vec4f,
  normal: vec4f,
  tangent: vec4f,
}
struct Influence { joints: vec4u, weights: vec4f }
struct Parameters { vertices: u32, targets: u32, sets: u32, skinned: u32
  ${batched ? ', paletteStride: u32, weightStride: u32, outputStride: u32, padding: u32' : ''}
}
@group(0) @binding(0) var<uniform> params: Parameters;
@group(0) @binding(1) var<storage, read> source: array<Vertex>;
@group(0) @binding(2) var<storage, read> deltas: array<Vertex>;
@group(0) @binding(3) var<storage, read> influences: array<Influence>;
@group(0) @binding(4) var<storage, read> palette: array<mat4x4f>;
@group(0) @binding(5) var<storage, read> weights: array<f32>;
@group(0) @binding(6) var<storage, read_write> destination: array<Vertex>;

${batched ? '@group(0) @binding(7) var<storage, read> jobs: array<u32>;' : ''}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let v = id.x;
  // Y addresses only the uploaded active jobs; immutable primitive inputs are shared.
  ${batched ? 'let job = jobs[id.y];' : ''}
  if (v >= params.vertices) { return; }
  var vertex = source[v];
  // Targets are target-major, and all padding/W components of deltas are zero.
  for (var t = 0u; t < params.targets; t++) {
    let delta = deltas[t * params.vertices + v];
    vertex.position += weights[${batched ? 'job * params.weightStride + ' : ''}t] * delta.position;
    vertex.normal += weights[${batched ? 'job * params.weightStride + ' : ''}t] * delta.normal;
    vertex.tangent += weights[${batched ? 'job * params.weightStride + ' : ''}t] * delta.tangent;
  }
  if (params.skinned != 0u) {
    var blend = mat4x4f(vec4f(0), vec4f(0), vec4f(0), vec4f(0));
    var total = 0.0;
    for (var s = 0u; s < params.sets; s++) {
      let influence = influences[v * params.sets + s];
      for (var c = 0u; c < 4u; c++) {
        blend += palette[${batched ? 'job * params.paletteStride + ' : ''}influence.joints[c]] * influence.weights[c];
        total += influence.weights[c];
      }
    }
    // Inputs are validated to have positive total weight. Joint matrices already include
    // world transforms and inverse binds; skinned draws therefore use an identity model matrix.
    blend = blend * (1.0 / total);
    vertex.position = blend * vec4f(vertex.position.xyz, 1.0);
    let a = blend[0].xyz;
    let b = blend[1].xyz;
    let c = blend[2].xyz;
    let cofactor = mat3x3f(cross(b, c), cross(c, a), cross(a, b));
    let det = dot(a, cross(b, c));
    // Cofactor/determinant is inverse-transpose, including nonuniform scale. A singular
    // transform has no meaningful normal; match the CPU reference's identity fallback.
    if (det != 0.0) {
      vertex.normal = vec4f((cofactor * vertex.normal.xyz) / det, 0.0);
    }
    vertex.tangent = vec4f(mat3x3f(a, b, c) * vertex.tangent.xyz,
      vertex.tangent.w * select(1.0, -1.0, det < 0.0));
  }
  destination[${batched ? 'job * params.outputStride + ' : ''}v] = vertex;
}
`;
}

export const deformationShader = shader(false);
export const batchedDeformationShader = shader(true);
