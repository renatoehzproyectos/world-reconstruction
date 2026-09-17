import { useState } from "react";
import { useReconstructionStore } from "@/lib/reconstruction/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
  onClose: () => void;
  className?: string;
};

function genMaterialId(): string {
  return `mat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Custom facade materials (spec Phase 2), on top of the 5 built-in ones
 * baked into reconstruction/apply.ts's FACADE_MATERIAL_COLORS. A material
 * created here shows up in BuildingEditPanel's facade dropdown by name, and
 * colorOverrideFor() resolves it by id/name at render time. Still a flat
 * color, not a texture — see the same documented simplification everywhere
 * else facade materials are mentioned in this codebase.
 */
export function MaterialsLibraryPanel({ onClose, className }: Props) {
  const project = useReconstructionStore((s) => s.project);
  const upsertMaterial = useReconstructionStore((s) => s.upsertMaterial);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#a0806a");

  const materials = project?.deltas.materials ?? [];

  const handleAdd = () => {
    if (!name.trim()) return;
    upsertMaterial({ id: genMaterialId(), name: name.trim(), baseColor: color });
    setName("");
  };

  return (
    <div className={cn("flex h-full flex-col overflow-hidden", className)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-medium text-fg">Materials library</p>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="space-y-2 border-b border-border px-4 py-3">
        <Label className="text-xs">New material</Label>
        <div className="flex gap-2">
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-8 w-10 shrink-0 cursor-pointer rounded border border-border bg-transparent"
          />
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Weathered cedar"
            className="h-8 text-xs"
          />
          <Button size="sm" onClick={handleAdd} disabled={!name.trim()}>
            Add
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <p className="mb-2 text-[11px] text-subtle">
          Built-in: brick, plaster, wood, stone, concrete. Custom materials you add here also appear in every
          building's facade dropdown.
        </p>
        {materials.length === 0 ? (
          <p className="text-xs text-muted">No custom materials yet.</p>
        ) : (
          <ul className="space-y-2">
            {materials.map((m) => (
              <li key={m.id} className="flex items-center gap-2 rounded-md border border-border p-2">
                <span
                  className="h-5 w-5 shrink-0 rounded border border-border"
                  style={{ backgroundColor: m.baseColor }}
                />
                <span className="truncate text-sm text-fg">{m.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
