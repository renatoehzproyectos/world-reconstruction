import type { SidewalkFeature } from "@/lib/reconstruction/types";
import { useReconstructionStore } from "@/lib/reconstruction/store";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
  sidewalk: SidewalkFeature | null;
  sourceId: string | null;
  onClose: () => void;
  className?: string;
};

const MATERIALS = ["concrete", "brick", "asphalt", "gravel"];

export function SidewalkEditPanel({ sidewalk, sourceId, onClose, className }: Props) {
  const updateSidewalk = useReconstructionStore((s) => s.updateSidewalk);
  const removeSidewalk = useReconstructionStore((s) => s.removeSidewalk);
  const undo = useReconstructionStore((s) => s.undo);
  const redo = useReconstructionStore((s) => s.redo);

  if (!sidewalk || !sourceId) {
    return (
      <div className={cn("flex h-full flex-col", className)}>
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted">
          Click an existing sidewalk to edit it.
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

  return (
    <div className={cn("flex h-full flex-col overflow-hidden", className)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">Sidewalk</p>
          <p className="truncate font-mono text-[11px] text-subtle">{sourceId}</p>
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
              min={1}
              max={4}
              step={0.1}
              value={sidewalk.width}
              onChange={(e) => updateSidewalk(sourceId, { width: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="w-12 text-right font-mono text-xs">{sidewalk.width.toFixed(1)}</span>
          </div>
        </section>

        <section className="space-y-2">
          <Label>Curb height (m)</Label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={0.3}
              step={0.01}
              value={sidewalk.curbHeight}
              onChange={(e) => updateSidewalk(sourceId, { curbHeight: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="w-12 text-right font-mono text-xs">{sidewalk.curbHeight.toFixed(2)}</span>
          </div>
        </section>

        <section className="space-y-2">
          <Label>Material</Label>
          <div className="flex flex-wrap gap-2">
            {MATERIALS.map((m) => (
              <Button
                key={m}
                variant={sidewalk.material === m ? "default" : "outline"}
                size="sm"
                onClick={() => updateSidewalk(sourceId, { material: m })}
              >
                {m}
              </Button>
            ))}
          </div>
        </section>

        <Button
          variant="danger"
          size="sm"
          onClick={() => {
            removeSidewalk(sourceId);
            onClose();
          }}
        >
          Delete sidewalk
        </Button>
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
