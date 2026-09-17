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

/**
 * Named checkpoints of the delta layer (spec §9/§24) — separate from the
 * undo/redo stack, which is per-action and lost on reload. A revision is
 * explicit ("save this as a checkpoint I can come back to"), persists with
 * the project (see project/serialize.ts, which stores the whole project
 * including `history`), and restoring one is itself a single undoable
 * command rather than replaying every action since.
 */
export function HistoryPanel({ onClose, className }: Props) {
  const project = useReconstructionStore((s) => s.project);
  const saveRevision = useReconstructionStore((s) => s.saveRevision);
  const restoreRevision = useReconstructionStore((s) => s.restoreRevision);
  const [message, setMessage] = useState("");

  const history = project?.history ?? [];

  return (
    <div className={cn("flex h-full flex-col overflow-hidden", className)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-medium text-fg">History</p>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="border-b border-border px-4 py-3">
        <Label className="mb-1.5 block text-xs">Save a checkpoint</Label>
        <div className="flex gap-2">
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="e.g. Finished main street"
            className="h-8 text-xs"
          />
          <Button
            size="sm"
            disabled={!project || !message.trim()}
            onClick={() => {
              saveRevision(message.trim());
              setMessage("");
            }}
          >
            Save
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {history.length === 0 ? (
          <p className="text-xs text-muted">No checkpoints yet. Save one above to be able to roll back to it later.</p>
        ) : (
          <ul className="space-y-2">
            {[...history].reverse().map((rev) => (
              <li key={rev.id} className="rounded-md border border-border p-2">
                <p className="truncate text-sm text-fg">{rev.message}</p>
                <p className="text-[11px] text-subtle">{new Date(rev.createdAt).toLocaleString()}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => restoreRevision(rev.id)}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
