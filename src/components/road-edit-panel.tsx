import { useMemo } from "react";
import type { ReconstructedRoad } from "@/lib/reconstruction/apply";
import { useReconstructionStore } from "@/lib/reconstruction/store";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
  road: ReconstructedRoad | null;
  sourceId: string | null;
  onClose: () => void;
  className?: string;
};

export function RoadEditPanel({ road, sourceId, onClose, className }: Props) {
  const project = useReconstructionStore((s) => s.project);
  const upsertRoadEdit = useReconstructionStore((s) => s.upsertRoadEdit);
  const undo = useReconstructionStore((s) => s.undo);
  const redo = useReconstructionStore((s) => s.redo);

  const edit = useMemo(() => {
    if (!project || !sourceId) return null;
    return project.deltas.roadEdits.find((e) => e.sourceId === sourceId) ?? null;
  }, [project, sourceId]);

  if (!road || !sourceId) {
    return (
      <div className={cn("flex h-full flex-col", className)}>
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted">
          Click a road to edit it. Deleted a road by mistake? Use Undo below.
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

  const width = edit?.width ?? road.width;

  return (
    <div className={cn("flex h-full flex-col overflow-hidden", className)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">Road</p>
          <p className="truncate font-mono text-[11px] text-subtle">
            {sourceId} · {road.highway}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 px-4 py-4">
        <section className="space-y-2">
          <Label>Width (m)</Label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={1.5}
              max={24}
              step={0.5}
              value={width}
              onChange={(e) => upsertRoadEdit(sourceId, { width: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="w-12 text-right font-mono text-xs">{width.toFixed(1)}</span>
          </div>
        </section>

        <Button
          variant="danger"
          size="sm"
          onClick={() => upsertRoadEdit(sourceId, { deleted: !edit?.deleted })}
        >
          {edit?.deleted ? "Restore road" : "Delete road"}
        </Button>
      </div>
    </div>
  );
}
