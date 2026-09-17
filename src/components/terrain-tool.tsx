import { useReconstructionStore } from "@/lib/reconstruction/store";
import type { TerrainEdit } from "@/lib/reconstruction/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type TerrainBrush = { kind: TerrainEdit["kind"]; radius: number; amount: number };

type Props = {
  active: boolean;
  onToggle: (active: boolean) => void;
  brush: TerrainBrush;
  onBrushChange: (brush: TerrainBrush) => void;
  className?: string;
};

const KINDS: TerrainEdit["kind"][] = ["raise", "lower", "flatten", "smooth"];

/**
 * Controls for the terrain-sculpt tool. The actual sculpt happens on
 * terrain click in CityViewer (pickMode="terrain") — this panel only owns
 * brush settings (radius/amount/kind) and shows the edit count. Every
 * stroke triggers a full scene rebuild for now (see
 * BuildSceneOptions.externalHeightGrid) — fine for MVP, worth debouncing
 * or partial-updating if brush dragging ever needs to feel smoother.
 */
export function TerrainTool({ active, onToggle, brush, onBrushChange, className }: Props) {
  const project = useReconstructionStore((s) => s.project);
  const editCount = project?.deltas.terrainEdits.length ?? 0;

  return (
    <div className={cn("space-y-3 rounded-lg border border-border bg-surface/95 p-3", className)}>
      <div className="flex items-center justify-between">
        <Label>Terrain sculpt</Label>
        <Button variant={active ? "default" : "outline"} size="sm" onClick={() => onToggle(!active)}>
          {active ? "On — click terrain" : "Off"}
        </Button>
      </div>

      {active && (
        <>
          <div className="flex flex-wrap gap-2">
            {KINDS.map((k) => (
              <Button
                key={k}
                variant={brush.kind === k ? "default" : "outline"}
                size="sm"
                onClick={() => onBrushChange({ ...brush, kind: k })}
              >
                {k}
              </Button>
            ))}
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted">
              <span>Radius</span>
              <span className="font-mono">{brush.radius.toFixed(0)} m</span>
            </div>
            <input
              type="range"
              min={2}
              max={60}
              step={1}
              value={brush.radius}
              onChange={(e) => onBrushChange({ ...brush, radius: Number(e.target.value) })}
              className="w-full"
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted">
              <span>{brush.kind === "flatten" ? "Target height" : "Amount"}</span>
              <span className="font-mono">{brush.amount.toFixed(1)} m</span>
            </div>
            <input
              type="range"
              min={brush.kind === "flatten" ? -20 : 0.2}
              max={brush.kind === "flatten" ? 40 : 10}
              step={0.1}
              value={brush.amount}
              onChange={(e) => onBrushChange({ ...brush, amount: Number(e.target.value) })}
              className="w-full"
            />
          </div>

          <p className="text-[11px] text-subtle">
            {editCount} terrain edit{editCount !== 1 ? "s" : ""} so far.
          </p>
        </>
      )}
    </div>
  );
}

export function makeTerrainEditFromClick(
  brush: TerrainBrush,
  localX: number,
  localZ: number
): Omit<TerrainEdit, "id" | "createdAt"> {
  return {
    kind: brush.kind,
    localX,
    localZ,
    radius: brush.radius,
    amount: brush.kind === "lower" ? -Math.abs(brush.amount) : brush.amount,
    falloff: 0.5,
  };
}

