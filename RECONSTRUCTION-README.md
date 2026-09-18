# World Reconstruction Platform — build log & final status

**This is not 100% complete, and can't be from inside this sandbox.** Below
is exactly what that means, section by section, rather than a vague
progress number. See "What genuinely cannot be finished here" at the bottom
before anything else — read that first if you're deciding what to do next.

## What exists now

### 1. Stable feature IDs (`src/lib/city/types.ts`, `parse-overture.ts`)
Added optional `id` to `BuildingFeature`/`RoadFeature` and threaded Overture's
GERS `id` through `overtureBuildingsToFeatures`, `overtureSegmentsToRoads`,
and `overtureToCityData`. This was a real gap: the edit-delta model needs a
stable join key between a generated building/road and its human edits, and
the parser was previously dropping Overture's id on the floor.

Known limitation: bbox-clipping can split one Overture feature into multiple
polygon pieces that currently share the same id. Fine for MVP; worth revisiting
before the id is used for anything more than "does an edit apply to this
building."

### 2. `src/lib/reconstruction/types.ts`
The full delta-layer data model from spec §4/§5/§8/§23: `TerrainEdit`,
`BuildingEdit` (floors, height, roof, per-facade material, windows, doors,
fence), `RoadEdit`, `SidewalkFeature`, `SceneObject`, `MaterialDefinition`,
`Revision`, and the top-level `ReconstructionProject`. Edits are semantic
(`{ floors: 2 }`), never mesh-vertex level, per spec §23.

### 3. `src/lib/reconstruction/apply.ts`
`applyReconstruction(base, deltas)` — merges base `CityData` with the delta
layer into a `ReconstructedWorld`. Pure function, never mutates `base`. Every
building/road in the output is tagged `origin: "generated" | "human-edited" |
"human-added"` so the renderer/UI can visually distinguish machine data from
human work (spec §3 step 5).

`applyTerrainEdits(grid, edits)` applies terrain sculpt strokes as an additive
offset over the base `HeightGrid` (from `city/elevation.ts`), same
non-destructive principle — the Copernicus/Terrarium grid itself is never
touched.

### 4. `src/lib/reconstruction/store.ts`
Zustand store holding the active `ReconstructionProject` plus an undo/redo
command stack (spec §27). Every mutator (`upsertBuildingEdit`, `addObject`,
`addTerrainEdit`, `addSidewalk`, ...) pushes a `Command` with a `do`/`undo`
pair onto the stack.

### 5. `src/lib/project/serialize.ts`
Save/load/export/import for `ReconstructionProject` (spec §17E, §28).
MVP-scoped to `localStorage` — deliberately isolated behind this one file so
swapping in PGlite or server persistence later doesn't touch anything else in
`reconstruction/`. Stores the reconstruction *state*, never a baked snapshot;
GLB stays an export target, not the source of truth.

## Progress (updated)

**~55% of the MVP vertical slice** (spec §32/33 bar: generate → pick a
building → edit → re-render → save → reload → export GLB).

| Piece | Status |
|---|---|
| Delta-layer data model, apply/merge, undo/redo store, serialize | Done, typechecked |
| Stable Overture ids through the parser | Done, typechecked |
| Building picking (merged-mesh raycast → sourceId) | Done, typechecked, **not visually verified** |
| Building edit panel (floors/roof/facade) → renders via `materializeCityData` | Done, typechecked, **not visually verified** |
| GLB export reflects edits | Done "for free" — CityViewer exports whatever `city` data it was given, and the workspace already feeds it `materializeCityData` output |
| Terrain sculpt tool (brush → click terrain → `TerrainEdit`) | Done, typechecked, **not visually verified**; every stroke does a full scene rebuild (see caveat below) |
| Save (localStorage) | Done; **reload-and-reattach not yet click-tested** |
| Roads / sidewalks / objects tools | Not started |
| Two-pane workspace polish (mobile tabs, loading states) | Minimal — functional grid layout only |

Verification method used throughout: `tsc --noEmit` after every change, a full
`vite build` (client + SSR + Vercel function bundle) after each milestone,
and a dev-server boot + SSR HTML fetch. All currently clean. What none of
that can catch: whether a raycast actually hits the building you clicked,
whether the highlight tint looks right, whether a terrain brush stroke feels
responsive. That needs a real browser — see "Recommended next step" below.

### New known limitation: terrain edits rebuild the whole scene
`buildCityMeshes` now accepts `externalHeightGrid` so terrain edits don't
re-fetch Copernicus/Terrarium on every stroke, but it still rebuilds
*everything* (buildings, roads, terrain, trees) on every edit — there's no
partial/incremental terrain update. Fine for click-to-sculpt; will feel bad
for drag-to-sculpt. Debouncing or a dedicated terrain-only fast path is the
fix, not yet done.



This was scoped as architecture + data model, not the full MVP UI. Still
needed before the spec's MVP definition-of-done (§33) is met:

- **Two-pane workspace UI.** `src/components/city-viewer.tsx` and
  `control-panel.tsx` are the existing 3D view/controls — they need a new
  shell component that puts a reference pane on the left (placeholder per
  spec §6: "do not fabricate a Street View API" — needs either the real
  Google Street View Static/embed API wired in with a key, or an explicit
  "reference not connected" state) and the 3D editor on the right.
- **`build-scene.ts` origin tinting.** Buildings/roads carry `origin:
  "generated"|"human-edited"|"human-added"` (see `reconstruction/apply.ts`)
  but nothing in the renderer visualizes that yet — spec is explicit that
  generated vs. human-modified content must stay visually distinguishable.
  `tintBuildingRange` (used for selection highlight) is the tool to reuse.
- **Placed-object rendering.** See "New known limitation" above.
- **Sidewalks.** `SidewalkFeature` data model + store action (`addSidewalk`)
  exist; no picking/UI/rendering yet.
- **Roof/facade/window/door edits don't render.** `BuildingEditPanel` writes
  these to the delta layer and they round-trip through save/load, but
  `materializeCityData` only maps `floors`/`height` onto the renderer today
  — `build-scene.ts` has no per-building material-override or roof-shape
  path yet. This is the single biggest remaining gap between "the UI lets
  you set it" and "you actually see it."
- **Terrain-stroke performance.** Full rebuild per click; fine for
  click-to-sculpt, not for drag.
- **Reload-and-reattach not click-tested.** Save → refresh → does the same
  project reload with edits intact? Code path exists (`projectIdFor` is
  deterministic per bbox+release), never seen running.

## Progress (updated — closing the "set it but doesn't render" gaps)

**~85% of the MVP vertical slice.** This pass closed most of the previously
flagged rendering gaps:

| Piece | Status |
|---|---|
| Facade material edits → visible | Done, typechecked, built. Flat vertex-color tint per material name (`brick`/`plaster`/`wood`/`stone`/`concrete`), not real textures — see `FACADE_MATERIAL_COLORS` in `apply.ts` |
| Roof type/rise edits → visible | Done. All non-flat types render as the existing pyramid/hip shape at the user's chosen rise — true distinct gable/shed silhouettes not modeled |
| Origin tinting (generated vs. human-edited vs. human-added) | Done — subtle warm-accent blend on buildings and roads, spec §3 step 5 |
| Placed objects → actually rendered | Done. 19 `SceneObjectKind`s each get a simple primitive mesh (tree = cone+cylinder, bench = box, etc.) — not real assets, but visible and positioned correctly on the terrain |
| Road picking + edit panel (width, delete) | Done (previous pass) |
| Everything else from before | Unchanged |

Verification: `tsc --noEmit` clean, full `vite build` (client+SSR+Vercel
function) clean, dev server boots and serves real SSR HTML, all touched
modules transform without error. **Still nothing visually confirmed in an
actual browser** — that remains the biggest gap between "looks done" and
"is done."

### Documented simplifications (intentional, not bugs)
- Facade material = one flat color for the whole building, not per-side,
  not textured. If a user sets different materials on different facades,
  the first one found (by side order) wins for the whole building.
- Roof type = only one 3D shape (pyramid/hip) exists; "gable"/"shed"/"custom"
  all render as that shape, just possibly a different rise.
- Placed objects = primitive geometry, not real models.
- `city/types.ts` now carries `colorOverride`/`roofOverride`/`origin` on
  `BuildingFeature`/`RoadFeature` — generic rendering hints, not
  reconstruction-specific types, so `city/` doesn't need to import from
  `reconstruction/` for the *data* path. `build-scene.ts` does have one
  type-only import from `reconstruction/types.ts` (`SceneObject`) — noted
  inline as a deliberate, compile-time-only exception rather than
  duplicating the kind list.

## Progress (updated — sidewalks, closing the last Phase-1 render gap)

**~95% of the MVP vertical slice.** Sidewalks were the last Phase-1 feature
with a data model but no tool/render:

| Piece | Status |
|---|---|
| Sidewalk drawing tool (two clicks → straight segment) | Done, typechecked, built |
| Sidewalk rendering (raised concrete-colored ribbon, reuses road ribbon extrusion) | Done |
| Sidewalk picking index (`resolveSidewalkAtFace`) | Done — no edit panel wired to it yet (width is set at draw time only; no click-to-re-edit-width after the fact) |

Verification: `tsc --noEmit` clean, full `vite build` clean, dev server
boots and serves real SSR HTML, touched modules transform without error.
Same caveat as every previous pass: **not yet seen rendering in an actual
browser.**

### New known limitation: sidewalks are straight two-point segments only
No multi-point path drawing, no curves, no snapping to an actual road edge.
Good enough to prove the feature exists and renders; a real "walk along this
street and lay a sidewalk" tool needs continuous path drawing (click to add
each point, double-click/escape to finish) — a meaningfully bigger tool than
what's here.

## Progress (updated — sidewalk editing + revision history)

**Phase 1 (MVP) is now feature-complete on paper: ~100%.** Phase 2 work
started with the first Phase 2 feature: revision history.

| Piece | Status |
|---|---|
| Sidewalk edit panel (width, curb height, material, delete) + "Edit sidewalks" pick mode | Done, typechecked, built |
| Store: `updateSidewalk`/`removeSidewalk` | Done |
| **Revision history (spec §9/§24)** — save a named checkpoint of the current delta layer, list checkpoints, restore one | Done, typechecked, built. `ReconstructionProject.history` (previously an inert field nothing ever wrote to) is now live |
| `HistoryPanel` UI, wired into the workspace toolbar | Done |

Restoring a revision is implemented as a single undoable Command (not a
replay of every action since), consistent with how every other edit in this
codebase works. Revisions persist with the project through the existing
`project/serialize.ts` save/load path — no separate storage needed, since a
revision is just a deltas snapshot living inside the project JSON that was
already being saved whole.

Verification: `tsc --noEmit` clean, full `vite build` clean, dev server
boots and serves real SSR HTML, all touched modules transform without
error. Still nothing visually confirmed in an actual browser.

## Progress (updated — custom materials library)

**Phase 2: ~30%.** Second Phase 2 feature done: a real materials library,
not just the 5 hardcoded facade colors.

| Piece | Status |
|---|---|
| `MaterialsLibraryPanel` — name + color picker, create/list custom materials | Done, typechecked, built |
| `colorOverrideFor` in `apply.ts` now resolves a facade's material against the custom library first (by id or name), falling back to the 5 built-ins | Done |
| `BuildingEditPanel`'s facade dropdown lists custom materials in an optgroup alongside the built-ins | Done |
| Store: `upsertMaterial` (already existed, was unused until now) | Now actually wired to UI |

Still a flat color per material, not a texture — same documented
simplification as before, just extended to cover user-defined colors too
instead of only the 5 hardcoded ones.

Verification: `tsc --noEmit` clean, full `vite build` clean, dev server
boots and serves real SSR HTML, touched modules transform without error.

## Progress (updated — distinct roof shapes, multi-point sidewalks, Phase 3 foundation)

**Phase 2: ~55%. Phase 3: ~10% (first time above 0%).**

| Piece | Status |
|---|---|
| Distinct gable and shed roof geometry (`gableRoofGeometry`, `shedRoofGeometry` in build-scene.ts) | Done, typechecked, built. Previously all non-flat roof types rendered as the same pyramid/hip shape; now gable and shed are genuinely different meshes |
| Multi-point sidewalk drawing | Done — closes the "straight two-point segment only" limitation from the previous pass. Click adds points, "Finish segment" commits, "Cancel" discards |
| `forkProject()` in `reconstruction/types.ts` | Done — deep-copies a project's deltas into a new project with `forkedFrom` lineage recorded, source untouched |
| `ProjectBrowserPanel` — list every locally-saved project, open one, fork one | Done, wired into the workspace toolbar |

### New known limitation: opening/forking a project doesn't regenerate its base world
The project browser lets you switch `ReconstructionWorkspace`'s active
project to any saved project, but the 3D view still renders using whatever
base `CityData` is currently generated in `useStudio` — it does **not**
re-fetch/re-generate the base world for the opened project's `bbox`. If you
open a project for a different location than what's currently generated,
you'll see that project's edits applied to the wrong base world. This is a
real correctness gap, not just a rendering nicety — flagging it clearly
rather than letting the "Open" button imply more than it does. Fix is to
trigger `useStudio`'s generation flow for the opened project's `source.bbox`
before loading its deltas.

### New known limitation: gable/shed roof winding is unverified
Both new roof shapes were written by inference from the existing pyramid
roof's coordinate conventions, not verified against a running render.
There's a real chance a gable end or shed face has an inverted winding and
renders as invisible from some angles (backface culling) — noted inline in
`build-scene.ts` as something to check once this is actually seen running.

Verification: `tsc --noEmit` clean, full `vite build` clean, dev server
boots and serves real SSR HTML, touched modules transform without error.

## Recommended next step

This is genuinely a multi-session build with a lot of interactive/visual
iteration (3D picking, brush tools, panel UI). That kind of iteration is a
much better fit for **Claude Code**, where the dev server can actually run
and get clicked through, than for further back-and-forth in this chat.
Point Claude Code at this repo and the vertical slice to build next is:

```
generate → pick a building in the 3D view → change its floor count via a
panel → see it re-render taller → save → reload the page → see the same
building still 2 floors → export GLB
```

That's the smallest slice that proves the whole delta-layer architecture end
to end (spec §32/§33's actual MVP bar), and everything above is aimed at
making that slice cheap.

## Progress (updated — closing the last two code-side gaps)

Everything from the previous "finish it" request that was actually
achievable without a backend or real reference imagery is now done:

| Piece | Status |
|---|---|
| **Per-side facade rendering** — each cardinal facade (N/S/E/W) can now have its own color, not one flat tint for the whole building | Done. Required replacing the wall geometry builder (walls were previously one `THREE.ExtrudeGeometry` per building) with a per-edge quad builder (`buildWallsWithFacades`) plus a separate top-cap builder (`buildTopCap`), used only for buildings with facade colors set and no holes |
| **Winding correctness — empirically verified, not just reasoned about** | `scripts/verification/verify-walls.mjs` and `verify-cap.mjs` construct the exact same geometry this code produces and check every resulting face normal against Three's real cross-product math, for CW/CCW squares, an irregular pentagon, and a concave L-shape. All pass. This caught a real bug before it shipped — see below |
| **A real bug caught by that verification, not by inspection** | `THREE.ShapeUtils.triangulateShape`'s winding turned out to be consistently backwards for a +Y-facing cap, regardless of input ring winding. Without the verification script this would have shipped as "reasoned to be probably fine" like the gable/shed roofs did last pass, and would have been wrong. Fixed with a one-line index reversal, then re-verified |
| **A second bug caught in the same pass**: mismatched vertex attributes | `THREE.ExtrudeGeometry` (used for the old wall path) always generates UV coordinates, needed because `ENABLE_WINDOWS: true` puts a window texture on the buildings material. The new manual wall/cap geometries didn't have UVs. `mergeGeometries` silently drops to "keep only the first geometry" when attribute sets don't match across the whole batch — this would have made most buildings vanish from the merged mesh. Fixed by adding UVs to both new geometry builders |
| **A third bug caught in the same pass**: pick-index desync | Adding the top cap as a second geometry per building, without updating the vertex/triangle-range bookkeeping used for click-picking, would have silently broken picking for every building constructed *after* the first one with facade colors (cumulative offset drift). Fixed by folding the cap's counts into the same pick-index entry as its wall |
| **Batch/multi-select editing** | Done. Shift-click adds buildings to a selection (multi-highlight in the 3D view, via a `Map` of saved-color backups instead of a single one). `BuildingEditPanel` now has two modes: the original single-building editor, and a batch editor (relative floor delta, roof type, facade material) that applies to every selected building via one `upsertBuildingEdit` per building |
| **Fixed the project-open correctness bug** from the previous pass | Opening a saved project for a different bbox now triggers real regeneration for that bbox before loading its deltas, instead of silently applying edits to the wrong buildings |

### Known limitation, stated plainly: batch undo isn't atomic
A batch edit applying to 5 buildings pushes 5 separate undo-stack entries,
one per building — undo unwinds them one at a time, not all 5 in one step.
Correct, just not as convenient as it could be. A real fix would group a
batch operation into one Command; not done here.

### What this pass does NOT claim
Everything above is real code, typechecked, built, and — for the wall/cap
winding specifically — actually tested against Three's real math outside
the browser sandbox this session can't open. That is a genuinely stronger
verification than most of this project's previous passes. It is still not
the same as a human clicking through the running app. The winding tests
prove the *geometry math* is correct; they can't prove the *picking*,
*UI state management*, or *visual appearance* are correct, because those
need a DOM, a GPU, and a person. That gap is unchanged by this pass.

---

## Progress (updated — real Street View reference imagery)

**§6 is no longer a placeholder.** The person using the app can now enter
their own Google Maps API key in Settings, save it, and the reference pane
starts showing real Street View imagery instead of the "not connected"
placeholder — exactly the decision that was previously flagged as
something only the user could make (not fabricated or assumed by this
session).

| Piece | Status |
|---|---|
| `reference/settings.ts` — get/set/clear the API key, `localStorage`-backed ("save forever") | Done, typechecked, built |
| `SettingsPanel` — textbox, Save, Clear, wired into the workspace toolbar | Done |
| `GoogleStreetViewProvider` — real `ReferenceProvider` implementation using the Maps JS API script-tag-plus-callback pattern (matches the working test file this was built from) | Done, typechecked, built |
| `getReferenceProvider()` picks it automatically once a key is saved, `refreshReferenceProvider()` makes a just-saved key take effect without a page reload | Done |
| `checkAvailability()` calls `StreetViewService.getPanorama` to confirm imagery actually exists near the location, not just that the key/SDK work | Done |

### What's still true about this, honestly
- **Never tested against a real key.** This sandbox's network egress doesn't
  reach `maps.googleapis.com` (allowlisted domains are package registries
  only), so the script-loading and panorama-mounting code has never
  actually run against Google's servers. It follows the exact pattern from
  the working test file provided, and it typechecks/builds/transforms
  clean — but "matches a pattern known to work" and "confirmed working" are
  different claims, and this is the first one.
- **Minimal ambient typing, not the full SDK types.** `google-street-view.ts`
  declares just the handful of Maps JS API shapes this file calls — not the
  full `@types/google.maps` surface. Fine for what's used; would need
  extending for anything beyond a basic panorama.
- **Heading/pitch now link to the 3D camera** — see the new section below,
  this was fixed after being flagged here.
- The key itself never touches this app's own network calls — it's read
  from `localStorage` and handed straight to Google's own script tag in the
  browser. Worth being aware of the usual caveats of a client-side API key
  (restrict it to the relevant APIs and to your own domain/referrers in the
  Google Cloud Console) — that's a Google Cloud Console setting, not
  something this app enforces.

## Progress (updated — camera-linked heading + a real bug fixed from live testing)

**First bug report from an actual running instance, and it's fixed.** Two
things this pass:

### Bug fix: `mergeGeometries()` "index attribute" crash

The person testing this reported:

```
Error: THREE.BufferGeometryUtils: .mergeGeometries() failed with geometry
at index 1. All geometries must have compatible attributes; make sure
index attribute exists among all geometries, or in none of them.
```

Root cause, confirmed by reproduction rather than guessed: `extrudeShape()`
(used for buildings without a facade-color override) produces **non-indexed**
geometry — this was empirically checked, not assumed, and turned out to
contradict what the per-side facade work from a previous pass assumed.
`buildWallsWithFacades()`/`buildTopCap()` (added for per-side facade
rendering) produced **indexed** geometry. `mergeGeometries()` requires an
entire batch to be uniformly indexed or uniformly non-indexed; mixing them
is exactly what threw this error, for any base world containing at least
one building with a facade-color edit next to one without.

Fix: both functions now return `geo.toNonIndexed()`, matching
`extrudeShape()`'s existing (and apparently load-bearing) convention.
Verified with a standalone script,
`scripts/verification/repro-merge-index-mismatch.mjs`, which builds a
realistic 5-building mixed batch (matching real construction order) using
the exact same logic as the real code, confirms the failure reproduces
before the fix and resolves after it. Also confirmed roof geometries
(`roofGeometry`/`gableRoofGeometry`/`shedRoofGeometry`/`roofClutterGeometry`)
were never at risk of the same bug — all four are indexed, consistently.

This is the first bug in this project caught by an actual user running the
actual app, rather than by typecheck/build/standalone-script verification.
It's a good illustration of exactly the gap this document has been honest
about all along: none of the verification tooling used in previous passes
(tsc, vite build, SSR boot, geometry-math scripts) could have caught this,
because it only manifests when two specific code paths' outputs get merged
together at runtime with real data. That needs a running app.

### Reference pane heading now tracks the 3D camera

Requested directly: "link heading." Previously the reference pane's
heading/pitch were wired through to the Street View panorama's `pov` but
always passed `0, 0` — no connection to the 3D view's camera. Now:

- `ReferenceProvider.mount()` was redesigned to return `{ update, dispose }`
  instead of a bare cleanup function, so a camera-orientation change (which
  can fire many times a second while orbiting) updates the existing
  panorama in place (`setPosition`/`setPov`) instead of tearing down and
  recreating it — the old cleanup-function shape would have made every
  camera frame remount the whole Street View panorama, unusable in
  practice.
- `city-viewer.tsx` reports the orbit camera's orientation via a new
  `onCameraChange` callback, throttled to ~150ms, using `OrbitControls`'
  own built-in `getAzimuthalAngle()`/`getPolarAngle()` — not hand-derived
  trigonometry.
- `reconstruction-workspace.tsx` holds that heading/pitch in state and
  feeds it into the `ReferenceView` passed to `ReferencePane`.
- Saving/clearing the API key in Settings now bumps a `providerVersion`
  passed to `ReferencePane` as a remount trigger, so switching from the
  placeholder to real Street View (or back) takes effect immediately
  without a page reload — this didn't work before since `ReferencePane`
  had no way to know the active provider had changed.

**Honest caveat on the heading/pitch mapping itself:** the conversion from
Three.js's azimuthal/polar angles to compass heading and Street View pitch
is a reasonable geometric mapping, not independently verified against
Street View's exact expectations or true compass north — consistent with
the same caveat already documented elsewhere in this codebase (e.g. the
facade-side classification in `buildWallsWithFacades`). It's never been
seen next to a real Street View panorama to confirm "look left in 3D, see
the same direction in Street View" actually holds.

## Progress (updated — the errors persisted, and here's why, with proof)

The previous fix (making `buildWallsWithFacades`/`buildTopCap` non-indexed)
was correct but incomplete — the person testing this reported the exact
same `mergeGeometries()` error plus a new one, `Cannot read properties of
null (reading 'getAttribute')`, after that fix was already in place. Rather
than guess again, this pass built real tooling to stop guessing:

### New verification approach: running the actual production code, not a reimplementation

`scripts/verification/repro-real-buildcitymeshes.mjs` uses **Vite's own SSR
module loader** — the same transform pipeline the real app uses in dev — to
import and call the real, unmodified `buildCityMeshes()` export against
realistic synthetic `CityData` (mixed plain/facade-colored/holed buildings,
roof overrides). This is a meaningfully stronger check than every previous
verification script in this project, which re-implemented the logic under
test by hand and could only prove "my re-implementation is internally
consistent," not "the actual shipped code works." A minimal `document`
stub (a permissive fake canvas 2D context) lets it run outside a browser
DOM, since `createWindowTexture()` needs `document.createElement`.

Running this against the walls/facade fix from last pass: **success, no
crash.** That fix was genuinely correct. So the user's continued error had
to be coming from somewhere else.

### The real second bug, found by testing with tree scattering enabled

The first repro script disabled tree scattering (`treeDensity: 0`) for
simplicity — it never exercised `scatterTrees()`/`createTreeGeometry()` at
all. Re-running with tree scattering enabled and a synthetic height grid
(`scripts/verification/repro-tree-merge.mjs`) reproduced **both** errors
exactly, with a real stack trace:

```
THREE.BufferGeometryUtils: .mergeGeometries() failed with geometry at
index 1. All geometries must have compatible attributes...
THREW: TypeError: Cannot read properties of null (reading 'getAttribute')
    at paintTree (build-scene.ts:1268:23)
    at createTreeGeometry (build-scene.ts:1342:2)
    at scatterTrees (build-scene.ts:1599:20)
```

Root cause: `IcosahedronGeometry` is **non-indexed** in this Three version,
while `CylinderGeometry`/`ConeGeometry` are **indexed** — confirmed
empirically, the same way every indexing claim in this document has been
checked rather than assumed. `createTreeGeometry`'s "round" and "layered"
tree shapes (2 of the 3 variants scattered trees randomly pick from) mix an
Icosahedron canopy with a Cylinder trunk. `mergeGeometries()` returned
`null` for those two variants; a `!` non-null assertion immediately after
silently lied to TypeScript about that, and `paintTree(null, ...)` threw
exactly the error reported.

**This bug predates this session's work entirely** — it was already in the
`bmap`/City-GLB reference project this whole thing was built on top of,
latent because nothing before this session had run `buildCityMeshes()` with
tree scattering enabled against real code and actually looked at the
result. It's not a regression from the facade-rendering work; it's a
second, independent, older bug that live testing happened to surface at
the same time.

**Fix:** every primitive contributing to a tree's merged geometry is now
normalized to non-indexed (`.toNonIndexed()`) before merging, for all three
variants — not just the two that were broken, so this can't quietly regress
if a future Three version changes another primitive's default indexing.
Added a defensive fallback (log + empty geometry instead of a crash) for
the same reason. Re-running `repro-tree-merge.mjs` against the fix: 195
trees scattered successfully, no crash, no error.

### Why this matters more than the fix itself

This is the clearest demonstration yet of the gap this document has named
every pass: the previous fix was real and correct, verified by every tool
available at the time, and it was still not the whole story, because a
different code path (tree scattering) simply hadn't been exercised. The
fix for *that* now exists specifically because someone ran the actual app
and reported what actually broke — confirming, again, that this kind of
bug is structurally invisible to typecheck/build/standalone-script
verification and only surfaces from real use.

---

# Final status audit (spec section by section)

This maps every major spec section to what's actually true right now, not
what sounds complete. "Built" means code exists, typechecks, and builds.
None of it has been confirmed correct by a human clicking through it in a
browser — treat every "Built" below as "built and plausible," not "verified."

| Spec area | Status | Notes |
|---|---|---|
| §2/§3 Two-pane workspace | Built | Reference pane + 3D editor, functional grid layout, minimal mobile polish |
| §4 Base + delta non-destructive editing | Built | Core architecture, the thing everything else sits on |
| §5.1–5.3 Building edits (floors, height, roof, facade) | Built | Roof: gable/shed/hip distinct shapes; facade: real per-side colors now (was flat-tint whole-building), still not textures |
| §5.5 Sidewalks | Built | Multi-point paths, width/curb/material editing, delete |
| §5.11/5.12 Placed objects | Built | 19 kinds, primitive geometry not real assets |
| §6 Reference imagery | Built | Real `GoogleStreetViewProvider` using the user's own API key, entered and saved in Settings — see above. Never run against a real key (no network access to Google's servers from this sandbox) |
| §8 Project data model | Built | Full `ReconstructionProject` type, save/load |
| §9/§24 Revision history | Built | Named checkpoints, restore, persists with project |
| §14/§23 Semantic (not vertex) edits | Built | Every edit type is a typed record, never raw geometry |
| §17E Save/load | Built | localStorage-backed; swappable for server storage later behind one file |
| §26 Performance (merged meshes, not per-object draw calls) | Built | Buildings/roads/sidewalks each one draw call; picking via vertex-range index, not per-object meshes |
| §27 Undo/redo | Built | Command stack, every mutator pushes do/undo |
| §28 Export reflects edits | Built | GLB export shares the same materialized data as the render |
| §32/33 MVP definition-of-done | Built | Generate → pick → edit → save → export chain all present |
| Materials library (Phase 2) | Built | Custom named/colored materials, not textures |
| Batch/multi-select edits | Built | Shift-click multi-select, batch floor/roof/facade edits — undo is per-building within a batch, not one atomic step (documented limitation) |
| Phase 3: forking | Built (client-only) | `forkProject`, no server, so "forking someone else's work" isn't possible — only your own saved projects |
| Phase 3: sharing/discovery | **Not built — needs a backend** | No database, no auth, no hosting for other users' projects |
| Phase 3: moderation | **Not built — needs a backend + policy work** | Not a coding task alone |

## What genuinely cannot be finished here

Two things are structurally outside what a code-generation session in a
sandbox can complete, regardless of how much more code gets written (a
third — reference imagery — was resolved once the user made that decision
and provided their own key/pattern; see "Real Street View reference
imagery" above):

1. **A real backend for Phase 3.** Community features mean other people's
   data, which means a server, a database, auth, and hosting. This repo is
   a client-side app; adding "community" without a backend would mean
   either faking it (which helps no one) or quietly building a backend
   nobody asked to provision, pay for, or operate.
2. **Visual/UX verification.** This is no longer "zero times seen running"
   — the merge-index bug fix above was a direct result of someone actually
   running the app and reporting a real crash, and it's the first bug this
   project has fixed from that kind of feedback rather than from
   typecheck/build/standalone-script checks alone. That's real progress on
   this exact gap, and also proof it was a real gap: none of this session's
   own verification tooling could have caught that bug. The gap isn't
   closed, though — most of this project (picking accuracy, visual
   correctness of the geometry, the Street View integration specifically,
   general usability) still hasn't been exercised by a person. Every "Done,
   typechecked, built" claim in this document remains honest about what was
   checked and equally honest about what wasn't.

## Honest bottom line

Phase 1 (the MVP) is feature-complete on paper. Phase 2 (richer editing) is
essentially done for what a solo coding session can build without a person
clicking through it — batch editing, per-side facades, distinct roof
shapes, materials library, and revision history are all in. Phase 3
(community) has a client-side foundation (local project browser, forking)
and nothing more — by design, since sharing/discovery/moderation require
infrastructure decisions and provisioning that belong to you, not to an
unattended coding session, and reference imagery (§6) requires an API key
and ToS decision only you can make.

What's left, in order of how much it would actually move confidence:

1. **A real browser session.** Unchanged advice from several passes ago,
   and the single highest-leverage thing left. Open this in Claude Code or
   run it locally, click through the vertical slice (generate → select a
   building → change its floors → confirm it visibly changes → save →
   reload → confirm the edit persisted → export GLB) and find out what's
   actually broken. The wall/cap winding math is now genuinely verified
   (see `scripts/verification/`) — a first for this project — but picking
   accuracy, UI state, and general usability still need a human.
2. Batch-undo atomicity (documented limitation, not urgent).
3. Anything under "§6" or "Phase 3: sharing/discovery/moderation" in the
   table above — out of scope for a coding session, not a to-do item.
