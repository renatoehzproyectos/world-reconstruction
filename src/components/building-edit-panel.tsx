import { useMemo } from "react";
import type { ReconstructedBuilding } from "@/lib/reconstruction/apply";
import type { BuildingEdit, FacadeSide, RoofEdit } from "@/lib/reconstruction/types";
import { useReconstructionStore } from "@/lib/reconstruction/store";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
  /** The reconstructed buildings the panel is showing, resolved by sourceIds. One building = the full single-building editor; more than one = batch edit mode. */
  buildings: ReconstructedBuilding[];
  sourceIds: string[];
  onClose: () => void;
  className?: string;
};

const ROOF_TYPES: RoofEdit["type"][] = ["flat", "gable", "hip", "shed"];
const FACADE_MATERIALS = ["default", "brick", "plaster", "wood", "stone", "concrete"];
const FACADE_SIDES: FacadeSide[] = ["north", "south", "east", "west"];

/**
 * Every control here writes a semantic delta (floors, roof type, facade
 * material — never a vertex) via upsertBuildingEdit, per spec §14/§23. The
 * panel never mutates the base BuildingFeature(s) it was given.
 *
 * Multi-select (shift-click in the 3D view, see city-viewer.tsx) renders a
 * simplified batch-edit UI instead of the full single-building editor: the
 * same floor delta, roof type, or facade material is applied to every
 * selected building via one upsertBuildingEdit call per building, each its
 * own undo-stack entry (so undo unwinds one building at a time, not the
 * whole batch atomically — a real, documented limitation, not an oversight).
 */
export function BuildingEditPanel({ buildings, sourceIds, onClose, className }: Props) {
  const project = useReconstructionStore((s) => s.project);
  const upsertBuildingEdit = useReconstructionStore((s) => s.upsertBuildingEdit);
  const undo = useReconstructionStore((s) => s.undo);
  const redo = useReconstructionStore((s) => s.redo);
  const customMaterials = project?.deltas.materials ?? [];

  if (sourceIds.length === 0) {
    return (
      <div className={cn("flex h-full flex-col items-center justify-center gap-2 p-6 text-center", className)}>
        <p className="text-sm text-muted">
          Click a building to edit it. Shift-click to select more than one for batch editing.
        </p>
      </div>
    );
  }

  if (!project) {
    return (
      <div className={cn("flex h-full items-center justify-center p-6 text-center text-sm text-muted", className)}>
        No active reconstruction project.
      </div>
    );
  }

  if (sourceIds.length === 1) {
    return (
      <SingleBuildingEditor
        building={buildings[0] ?? null}
        sourceId={sourceIds[0]}
        customMaterials={customMaterials}
        upsertBuildingEdit={upsertBuildingEdit}
        undo={undo}
        redo={redo}
        onClose={onClose}
        className={className}
      />
    );
  }

  return (
    <BatchBuildingEditor
      buildings={buildings}
      sourceIds={sourceIds}
      customMaterials={customMaterials}
      upsertBuildingEdit={upsertBuildingEdit}
      undo={undo}
      redo={redo}
      onClose={onClose}
      className={className}
    />
  );
}

type UpsertFn = (sourceId: string, patch: Omit<Partial<BuildingEdit>, "id" | "sourceId">) => void;
type CustomMaterial = { id: string; name: string };

function SingleBuildingEditor({
  building,
  sourceId,
  customMaterials,
  upsertBuildingEdit,
  undo,
  redo,
  onClose,
  className,
}: {
  building: ReconstructedBuilding | null;
  sourceId: string;
  customMaterials: CustomMaterial[];
  upsertBuildingEdit: UpsertFn;
  undo: () => void;
  redo: () => void;
  onClose: () => void;
  className?: string;
}) {
  const project = useReconstructionStore((s) => s.project);
  const edit = useMemo<BuildingEdit | null>(() => {
    if (!project) return null;
    return project.deltas.buildingEdits.find((e) => e.sourceId === sourceId) ?? null;
  }, [project, sourceId]);

  if (!building) {
    return (
      <div className={cn("flex h-full items-center justify-center p-6 text-center text-sm text-muted", className)}>
        Building not found — it may have been removed.
      </div>
    );
  }

  const baseFloors = Math.max(1, Math.round(building.height / 3));
  const floors = edit?.floors ?? baseFloors;
  const height = edit?.height ?? (edit?.floors ? edit.floors * 3 : building.height);
  const roofType = edit?.roof?.type ?? "flat";
  const kind = building.origin === "human-added" ? "custom" : building.kind;

  const setFloors = (next: number) => {
    const clamped = Math.max(1, Math.min(60, next));
    upsertBuildingEdit(sourceId, { floors: clamped, height: undefined });
  };

  const setRoof = (patch: Partial<RoofEdit>) => {
    const nextRoof: RoofEdit = { type: edit?.roof?.type ?? "flat", ...edit?.roof, ...patch };
    upsertBuildingEdit(sourceId, { roof: nextRoof });
  };

  const setFacade = (side: FacadeSide, material: string) => {
    const nextFacades = { ...edit?.facades };
    if (material === "default") {
      delete nextFacades[side];
    } else {
      nextFacades[side] = { ...nextFacades[side], material };
    }
    upsertBuildingEdit(sourceId, { facades: nextFacades });
  };

  return (
    <div className={cn("flex h-full flex-col overflow-hidden", className)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">
            {building.origin === "human-added" ? "Custom building" : "Building"}
          </p>
          <p className="truncate font-mono text-[11px] text-subtle">
            {sourceId} · {kind}
            {building.origin === "human-edited" && " · edited"}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        <section className="space-y-2">
          <Label>Floors</Label>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="icon" onClick={() => setFloors(floors - 1)} disabled={floors <= 1}>
              −
            </Button>
            <div className="w-12 text-center font-mono text-sm">{floors}</div>
            <Button variant="secondary" size="icon" onClick={() => setFloors(floors + 1)}>
              +
            </Button>
            <span className="ml-2 text-xs text-muted">≈ {height.toFixed(1)} m</span>
          </div>
        </section>

        <section className="space-y-2">
          <Label>Roof</Label>
          <div className="flex flex-wrap gap-2">
            {ROOF_TYPES.map((type) => (
              <Button
                key={type}
                variant={roofType === type ? "default" : "outline"}
                size="sm"
                onClick={() => setRoof({ type })}
              >
                {type}
              </Button>
            ))}
          </div>
          {roofType !== "flat" && (
            <div className="flex items-center gap-2 pt-1">
              <Label className="text-xs text-muted">Rise (m)</Label>
              <input
                type="range"
                min={0.5}
                max={6}
                step={0.1}
                value={edit?.roof?.rise ?? 2.5}
                onChange={(e) => setRoof({ rise: Number(e.target.value) })}
                className="flex-1"
              />
              <span className="w-10 text-right font-mono text-xs">{(edit?.roof?.rise ?? 2.5).toFixed(1)}</span>
            </div>
          )}
        </section>

        <section className="space-y-2">
          <Label>Facade material</Label>
          <div className="grid grid-cols-2 gap-2">
            {FACADE_SIDES.map((side) => (
              <div key={side} className="space-y-1">
                <span className="text-[11px] capitalize text-subtle">{side}</span>
                <select
                  className="h-9 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-fg"
                  value={edit?.facades?.[side]?.material ?? "default"}
                  onChange={(e) => setFacade(side, e.target.value)}
                >
                  {FACADE_MATERIALS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  {customMaterials.length > 0 && (
                    <optgroup label="Custom">
                      {customMaterials.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
        <Button variant="outline" size="sm" onClick={undo}>
          Undo
        </Button>
        <Button variant="outline" size="sm" onClick={redo}>
          Redo
        </Button>
      </div>
    </div>
  );
}

function BatchBuildingEditor({
  buildings,
  sourceIds,
  customMaterials,
  upsertBuildingEdit,
  undo,
  redo,
  onClose,
  className,
}: {
  buildings: ReconstructedBuilding[];
  sourceIds: string[];
  customMaterials: CustomMaterial[];
  upsertBuildingEdit: UpsertFn;
  undo: () => void;
  redo: () => void;
  onClose: () => void;
  className?: string;
}) {
  const project = useReconstructionStore((s) => s.project);

  const currentFloorsFor = (b: ReconstructedBuilding): number => {
    const edit = project?.deltas.buildingEdits.find((e) => e.sourceId === b.id);
    return edit?.floors ?? Math.max(1, Math.round(b.height / 3));
  };

  const applyFloorDelta = (delta: number) => {
    for (const b of buildings) {
      if (!b.id) continue;
      const next = Math.max(1, Math.min(60, currentFloorsFor(b) + delta));
      upsertBuildingEdit(b.id, { floors: next, height: undefined });
    }
  };

  const applyRoof = (type: RoofEdit["type"]) => {
    for (const id of sourceIds) {
      const existing = project?.deltas.buildingEdits.find((e) => e.sourceId === id)?.roof;
      upsertBuildingEdit(id, { roof: { type, rise: existing?.rise } });
    }
  };

  const applyFacadeAll = (material: string) => {
    for (const id of sourceIds) {
      const existing = project?.deltas.buildingEdits.find((e) => e.sourceId === id)?.facades ?? {};
      const nextFacades = { ...existing };
      for (const side of FACADE_SIDES) {
        if (material === "default") delete nextFacades[side];
        else nextFacades[side] = { ...nextFacades[side], material };
      }
      upsertBuildingEdit(id, { facades: nextFacades });
    }
  };

  return (
    <div className={cn("flex h-full flex-col overflow-hidden", className)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">{sourceIds.length} buildings selected</p>
          <p className="text-[11px] text-subtle">Changes below apply to all of them.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        <section className="space-y-2">
          <Label>Floors (relative)</Label>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => applyFloorDelta(-1)}>
              −1 floor to all
            </Button>
            <Button variant="secondary" size="sm" onClick={() => applyFloorDelta(1)}>
              +1 floor to all
            </Button>
          </div>
          <p className="text-[11px] text-subtle">
            Each building keeps its own base floor count — this shifts each by the same amount rather than setting
            them all to one value.
          </p>
        </section>

        <section className="space-y-2">
          <Label>Roof (all selected)</Label>
          <div className="flex flex-wrap gap-2">
            {ROOF_TYPES.map((type) => (
              <Button key={type} variant="outline" size="sm" onClick={() => applyRoof(type)}>
                {type}
              </Button>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <Label>Facade material (all sides, all selected)</Label>
          <div className="flex flex-wrap gap-2">
            {FACADE_MATERIALS.map((m) => (
              <Button key={m} variant="outline" size="sm" onClick={() => applyFacadeAll(m)}>
                {m}
              </Button>
            ))}
            {customMaterials.map((m) => (
              <Button key={m.id} variant="outline" size="sm" onClick={() => applyFacadeAll(m.id)}>
                {m.name}
              </Button>
            ))}
          </div>
        </section>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
        <Button variant="outline" size="sm" onClick={undo}>
          Undo
        </Button>
        <Button variant="outline" size="sm" onClick={redo}>
          Redo
        </Button>
      </div>
    </div>
  );
}
