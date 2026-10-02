# Physics backend evaluation

Evaluated for Phase 5 on October 2, 2026. Select **Rapier 3D compatibility 0.21.0**, pinned in the lockfile. Game systems depend on `PhysicsAdapter`; only `engine/physics/rapier.ts` imports backend types. Renderer passes and the viewer never import it.

| Candidate      | Browser integration                                                                                                                                              | Decision for this slice                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Rapier         | Async WASM initialization; compatibility package embeds WASM in JavaScript. Its character controller supplies sliding, stairs, slope limits and ground snapping. | Selected: matches the milestone and runs unchanged in CPU tests and a real browser.                               |
| JoltPhysics.js | Emscripten bindings with embedded or separate WASM builds; APIs follow its C++ interface. MIT licensed.                                                          | Viable later; a different native binding surface brings integration work without a demonstrated requirement here. |
| Ammo.js        | Emscripten port of Bullet exposing its API and native object lifetimes.                                                                                          | Viable for Bullet-specific needs; not integrated or benchmarked in this change.                                   |

Primary references: [Rapier loading](https://rapier.rs/docs/user_guides/javascript/getting_started_js/), [Rapier controller](https://rapier.rs/docs/user_guides/javascript/character_controller/), [Jolt bindings](https://github.com/jrouwe/JoltPhysics.js), [Ammo bindings](https://github.com/kripken/ammo.js). These are integration assessments, not comparative physics performance claims.

## License and delivery cost

Rapier is [Apache-2.0](https://github.com/dimforge/rapier/blob/master/LICENSE). Its installed license is copied to `public/licenses/rapier-apache-2.0.txt` and shipped by Vite at `/licenses/rapier-apache-2.0.txt`. The generated character and level are original project code and require no external model files or media licenses.

Measured with `pnpm build` (Vite 7.3.6), the game entry including embedded WASM is approximately **4.37 MB minified / 1.66 MB gzip**. This is a build-size estimate, not measured network traffic or WASM heap usage. The shared rendering entry is approximately **167 kB / 55 kB gzip**; the viewer-specific entry is approximately **7 kB / 2.5 kB gzip**. Decoder assets keep their lazy-loading path. Rapier is absent from the viewer entry and shared renderer chunk. A large-chunk warning for the game is expected.

Compatibility loading trades bundle size for initialization without extra WASM URLs, CDN access, workers or cross-origin isolation. If download/startup cost becomes a shipping constraint, evaluate the separate-WASM package against this baseline. Do not hide the cost by increasing Vite's warning threshold.

## Controller scope and verification

The adapter owns static cuboids and upright kinematic capsules. Character feet are world-space meters; capsule radius is 0.35 m, segment half-height 0.55 m and total height 1.8 m. It slides against walls, climbs steps up to 0.3 m, snaps down within 0.2 m, limits climb angles to 45 degrees, and uses gravity with a 5 m/s jump impulse. Visual dimensions are independent of collision dimensions. Dynamic-body gameplay, root motion and runtime collider editing are not implemented.

The application initializes WASM before creating systems. Fixed gameplay consumes intent; fixed physics computes movement, steps the shared world and publishes resolved positions through transform ownership. Teardown releases controllers/bodies and the WASM world once. CPU tests use the real backend for 30/60/144 render Hz, walls, stairs, jumping/landing and disposal. GPU tests exercise the playable page and independent deformation outputs during membership changes. Installed Microsoft Edge is the verified browser; cross-browser checks and backend throughput/memory measurements remain future work.
