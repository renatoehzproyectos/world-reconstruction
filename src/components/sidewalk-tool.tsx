import { useReconstructionStore } from "@/lib/reconstruction/store";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
  active: boolean;
  onToggle: (active: boolean) => void;
  width: number;
  onWidthChange: (width: number) => void;
  pendingPoints: { x: number; z: number }[];
  onFinish: () => void;
  onCancelPending: () => void;
  className?: string;
};

/**
 * Draws sidewalks (spec §5.5) as a multi-point path: each click on the
 * ground appends a point; "Finish segment" commits the path via
 * addSidewalk once at least 2 points exist. No curves or snapping to a
 * road edge — straight-line segments between clicked points only.
 */
export function SidewalkTool({
  active,
  onToggle,
  width,
  onWidthChange,
  pendingPoints,
  onFinish,
  onCancelPending,
  className,
}: Props) {
  const project = useReconstructionStore((s) => s.project);
  const count = project?.deltas.sidewalks.length ?? 0;

  return (
    <div className={cn("space-y-3 rounded-lg border border-border bg-surface/95 p-3", className)}>
      <div className="flex items-center justify-between">
        <Label>Sidewalks</Label>
        <Button variant={active ? "default" : "outline"} size="sm" onClick={() => onToggle(!active)}>
          {active ? "On" : "Off"}
        </Button>
      </div>

      {active && (
        <>
          <p className="text-xs text-muted">
            {pendingPoints.length === 0
              ? "Click the ground to start a path."
              : `${pendingPoints.length} point${pendingPoints.length !== 1 ? "s" : ""} placed — keep clicking to add more, or finish.`}
          </p>
          {pendingPoints.length > 0 && (
            <div className="flex gap-2">
              <Button variant="default" size="sm" onClick={onFinish} disabled={pendingPoints.length < 2}>
                Finish segment
              </Button>
              <Button variant="outline" size="sm" onClick={onCancelPending}>
                Cancel
              </Button>
            </div>
          )}

          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted">
              <span>Width</span>
              <span className="font-mono">{width.toFixed(1)} m</span>
            </div>
            <input
              type="range"
              min={1}
              max={4}
              step={0.1}
              value={width}
              onChange={(e) => onWidthChange(Number(e.target.value))}
              className="w-full"
            />
          </div>

          <p className="text-[11px] text-subtle">
            {count} sidewalk{count !== 1 ? "s" : ""} so far.
          </p>
        </>
      )}
    </div>
  );
}
