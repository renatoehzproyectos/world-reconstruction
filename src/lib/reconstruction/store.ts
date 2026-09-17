import { create } from "zustand";
import type {
  BuildingEdit,
  MaterialDefinition,
  ReconstructionDeltas,
  ReconstructionProject,
  Revision,
  RoadEdit,
  SceneObject,
  SidewalkFeature,
  TerrainEdit,
} from "./types";
import { emptyDeltas } from "./types";

/**
 * Every human operation is a Command with forward/inverse apply functions
 * (spec §27). Commands mutate only `deltas`, never the base world, so undo
 * is always well-defined regardless of what the generated data looks like.
 */
type Command = {
  label: string;
  do: (d: ReconstructionDeltas) => ReconstructionDeltas;
  undo: (d: ReconstructionDeltas) => ReconstructionDeltas;
};

type ReconstructionState = {
  project: ReconstructionProject | null;
  undoStack: Command[];
  redoStack: Command[];

  loadProject: (project: ReconstructionProject) => void;
  closeProject: () => void;

  upsertBuildingEdit: (sourceId: string, patch: Omit<Partial<BuildingEdit>, "id" | "sourceId">) => void;
  upsertRoadEdit: (sourceId: string, patch: Omit<Partial<RoadEdit>, "id" | "sourceId">) => void;
  addTerrainEdit: (edit: Omit<TerrainEdit, "id" | "createdAt">) => void;
  addObject: (obj: Omit<SceneObject, "id" | "createdAt">) => void;
  removeObject: (id: string) => void;
  addSidewalk: (path: SidewalkFeature["path"], width: number) => void;
  updateSidewalk: (id: string, patch: Omit<Partial<SidewalkFeature>, "id">) => void;
  removeSidewalk: (id: string) => void;
  upsertMaterial: (mat: MaterialDefinition) => void;

  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  /** Snapshot the current delta layer as a named checkpoint (spec §9/§24). */
  saveRevision: (message: string) => void;
  /** Roll the delta layer back to a prior checkpoint. This is itself undoable. */
  restoreRevision: (revisionId: string) => void;

  markSaved: () => void;
};

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function runCommand(state: ReconstructionState, cmd: Command): Partial<ReconstructionState> {
  if (!state.project) return {};
  const nextDeltas = cmd.do(state.project.deltas);
  return {
    project: {
      ...state.project,
      deltas: nextDeltas,
      metadata: { ...state.project.metadata, updatedAt: new Date().toISOString() },
    },
    undoStack: [...state.undoStack, cmd],
    redoStack: [],
  };
}

export const useReconstructionStore = create<ReconstructionState>((set, get) => ({
  project: null,
  undoStack: [],
  redoStack: [],

  loadProject: (project) => set({ project, undoStack: [], redoStack: [] }),
  closeProject: () => set({ project: null, undoStack: [], redoStack: [] }),

  upsertBuildingEdit: (sourceId, patch) => {
    const now = new Date().toISOString();
    const cmd: Command = {
      label: "Edit building",
      do: (d) => {
        const existing = d.buildingEdits.find((e) => e.sourceId === sourceId);
        const merged: BuildingEdit = existing
          ? { ...existing, ...patch, updatedAt: now }
          : { id: genId("bedit"), sourceId, ...patch, createdAt: now, updatedAt: now };
        return {
          ...d,
          buildingEdits: [...d.buildingEdits.filter((e) => e.sourceId !== sourceId), merged],
        };
      },
      undo: (d) => d, // snapshot-based undo below overrides this per-call
    };
    applyWithSnapshotUndo(set, get, cmd);
  },

  upsertRoadEdit: (sourceId, patch) => {
    const now = new Date().toISOString();
    const cmd: Command = {
      label: "Edit road",
      do: (d) => {
        const existing = d.roadEdits.find((e) => e.sourceId === sourceId);
        const merged: RoadEdit = existing
          ? { ...existing, ...patch, updatedAt: now }
          : { id: genId("redit"), sourceId, ...patch, createdAt: now, updatedAt: now };
        return { ...d, roadEdits: [...d.roadEdits.filter((e) => e.sourceId !== sourceId), merged] };
      },
      undo: (d) => d,
    };
    applyWithSnapshotUndo(set, get, cmd);
  },

  addTerrainEdit: (edit) => {
    const full: TerrainEdit = { ...edit, id: genId("terrain"), createdAt: new Date().toISOString() };
    const cmd: Command = {
      label: "Sculpt terrain",
      do: (d) => ({ ...d, terrainEdits: [...d.terrainEdits, full] }),
      undo: (d) => ({ ...d, terrainEdits: d.terrainEdits.filter((e) => e.id !== full.id) }),
    };
    set((state) => runCommand(state, cmd));
  },

  addObject: (obj) => {
    const full: SceneObject = { ...obj, id: genId("obj"), createdAt: new Date().toISOString() };
    const cmd: Command = {
      label: `Place ${obj.kind}`,
      do: (d) => ({ ...d, objects: [...d.objects, full] }),
      undo: (d) => ({ ...d, objects: d.objects.filter((o) => o.id !== full.id) }),
    };
    set((state) => runCommand(state, cmd));
  },

  removeObject: (id) => {
    const cmd: Command = {
      label: "Remove object",
      do: (d) => ({ ...d, objects: d.objects.filter((o) => o.id !== id) }),
      undo: (d) => d, // handled via snapshot fallback
    };
    applyWithSnapshotUndo(set, get, cmd);
  },

  addSidewalk: (path, width) => {
    const now = new Date().toISOString();
    const full: SidewalkFeature = {
      id: genId("sidewalk"),
      path,
      width,
      curbHeight: 0.15,
      material: "concrete",
      drivewayCuts: [],
      ramps: [],
      createdAt: now,
      updatedAt: now,
    };
    const cmd: Command = {
      label: "Add sidewalk",
      do: (d) => ({ ...d, sidewalks: [...d.sidewalks, full] }),
      undo: (d) => ({ ...d, sidewalks: d.sidewalks.filter((s) => s.id !== full.id) }),
    };
    set((state) => runCommand(state, cmd));
  },

  updateSidewalk: (id, patch) => {
    const cmd: Command = {
      label: "Edit sidewalk",
      do: (d) => ({
        ...d,
        sidewalks: d.sidewalks.map((s) =>
          s.id === id ? { ...s, ...patch, updatedAt: new Date().toISOString() } : s
        ),
      }),
      undo: (d) => d,
    };
    applyWithSnapshotUndo(set, get, cmd);
  },

  removeSidewalk: (id) => {
    const cmd: Command = {
      label: "Remove sidewalk",
      do: (d) => ({ ...d, sidewalks: d.sidewalks.filter((s) => s.id !== id) }),
      undo: (d) => d,
    };
    applyWithSnapshotUndo(set, get, cmd);
  },

  upsertMaterial: (mat) => {
    const cmd: Command = {
      label: "Edit material",
      do: (d) => ({ ...d, materials: [...d.materials.filter((m) => m.id !== mat.id), mat] }),
      undo: (d) => d,
    };
    applyWithSnapshotUndo(set, get, cmd);
  },

  undo: () => {
    const { project, undoStack } = get();
    if (!project || undoStack.length === 0) return;
    const cmd = undoStack[undoStack.length - 1];
    const nextDeltas = cmd.undo(project.deltas);
    set({
      project: { ...project, deltas: nextDeltas },
      undoStack: undoStack.slice(0, -1),
      redoStack: [...get().redoStack, cmd],
    });
  },

  redo: () => {
    const { project, redoStack } = get();
    if (!project || redoStack.length === 0) return;
    const cmd = redoStack[redoStack.length - 1];
    const nextDeltas = cmd.do(project.deltas);
    set({
      project: { ...project, deltas: nextDeltas },
      redoStack: redoStack.slice(0, -1),
      undoStack: [...get().undoStack, cmd],
    });
  },

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,

  saveRevision: (message) => {
    const { project } = get();
    if (!project) return;
    const revision: Revision = {
      id: `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      message,
      author: project.metadata.author,
      createdAt: new Date().toISOString(),
      // Deep-ish snapshot: the delta layer is small (edit records, not
      // geometry), so a structural clone here is cheap and avoids aliasing
      // bugs where a later edit mutates an array a past revision points to.
      snapshot: JSON.parse(JSON.stringify(project.deltas)) as ReconstructionDeltas,
    };
    set({
      project: {
        ...project,
        history: [...project.history, revision],
        metadata: { ...project.metadata, updatedAt: new Date().toISOString() },
      },
    });
  },

  restoreRevision: (revisionId) => {
    const { project } = get();
    if (!project) return;
    const revision = project.history.find((r) => r.id === revisionId);
    if (!revision) return;
    const before = project.deltas;
    const cmd: Command = {
      label: `Restore "${revision.message}"`,
      do: () => JSON.parse(JSON.stringify(revision.snapshot)) as ReconstructionDeltas,
      undo: () => before,
    };
    set((state) => runCommand(state, cmd));
  },

  markSaved: () => {
    const { project } = get();
    if (!project) return;
    set({ project: { ...project, metadata: { ...project.metadata, updatedAt: new Date().toISOString() } } });
  },
}));

/**
 * Some edits (upserts that overwrite a field a user might edit repeatedly,
 * e.g. dragging a height slider) are cheapest to undo via a before/after
 * deltas snapshot rather than a hand-written inverse. This keeps the
 * undo stack simple without giving up correctness.
 */
function applyWithSnapshotUndo(
  set: (fn: (state: ReconstructionState) => Partial<ReconstructionState>) => void,
  get: () => ReconstructionState,
  cmd: Command,
) {
  const before = get().project?.deltas ?? emptyDeltas();
  const snapshotCmd: Command = {
    label: cmd.label,
    do: cmd.do,
    undo: () => before,
  };
  set((state) => runCommand(state, snapshotCmd));
}
