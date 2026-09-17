import { useReconstructionStore } from "@/lib/reconstruction/store";
import type { SceneObjectKind } from "@/lib/reconstruction/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
  active: boolean;
  onToggle: (active: boolean) => void;
  kind: SceneObjectKind;
  onKindChange: (kind: SceneObjectKind) => void;
  className?: string;
};

const COMMON_KINDS: SceneObjectKind[] = [
  "tree",
  "bush",
  "bench",
  "street-light",
  "trash-can",
  "mailbox",
  "hydrant",
  "planter",
];

/**
 * Places free-standing scene objects (spec §5.11/§5.12) and renders them as
 * simple primitive meshes (see build-scene.ts sceneObjectsGeometry) — real
 * asset models are future work, but placement is visible now.
 */
export function ObjectPlacementTool({ active, onToggle, kind, onKindChange, className }: Props) {
  const project = useReconstructionStore((s) => s.project);
  const removeObject = useReconstructionStore((s) => s.removeObject);
  const objects = project?.deltas.objects ?? [];

  return (
    <div className={cn("space-y-3 rounded-lg border border-border bg-surface/95 p-3", className)}>
      <div className="flex items-center justify-between">
        <Label>Place objects</Label>
        <Button variant={active ? "default" : "outline"} size="sm" onClick={() => onToggle(!active)}>
          {active ? "On — click ground" : "Off"}
        </Button>
      </div>

      {active && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {COMMON_KINDS.map((k) => (
              <Button key={k} variant={kind === k ? "default" : "outline"} size="sm" onClick={() => onKindChange(k)}>
                {k}
              </Button>
            ))}
          </div>

          {objects.length > 0 && (
            <div className="max-h-32 space-y-1 overflow-y-auto">
              {objects.map((o) => (
                <div key={o.id} className="flex items-center justify-between text-xs text-muted">
                  <span>
                    {o.kind} @ ({o.localX.toFixed(0)}, {o.localZ.toFixed(0)})
                  </span>
                  <button className="text-danger hover:underline" onClick={() => removeObject(o.id)}>
                    remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
