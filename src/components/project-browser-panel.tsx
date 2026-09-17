import { useState } from "react";
import { listProjects, saveProject } from "@/lib/project/serialize";
import { forkProject, type ReconstructionProject } from "@/lib/reconstruction/types";
import { useReconstructionStore } from "@/lib/reconstruction/store";
import { useStudio } from "@/store/studio";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  onClose: () => void;
  className?: string;
};

function genProjectId(): string {
  return `proj_fork_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Lists every reconstruction project saved locally (spec Phase 3
 * foundation — no sharing/discovery/moderation yet, just "see and reopen
 * what I've saved, and fork one to branch off it"). Reads via
 * project/serialize.ts's localStorage-backed listProjects(), so this only
 * ever shows projects saved on this device/browser.
 *
 * Opening a project for a different bbox than what's currently generated
 * triggers a full regeneration first (see openProject below) so its edits
 * never get applied to the wrong base world.
 */
export function ProjectBrowserPanel({ onClose, className }: Props) {
  const [projects, setProjects] = useState(() => listProjects());
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const currentProject = useReconstructionStore((s) => s.project);
  const loadProjectIntoStore = useReconstructionStore((s) => s.loadProject);
  const currentBbox = useStudio((s) => s.bbox);
  const setBbox = useStudio((s) => s.setBbox);
  const generate = useStudio((s) => s.generate);

  /**
   * Opening a project whose base world doesn't match what's currently
   * generated used to silently apply its edits to the wrong buildings —
   * flagged as a real correctness gap in a previous pass. Fixed here: if
   * the bbox differs, re-run generation for the project's bbox first, then
   * load its deltas once that finishes. If the bbox matches, just load —
   * no need to regenerate what's already on screen.
   */
  const openProject = async (p: ReconstructionProject) => {
    const sameBbox =
      currentBbox &&
      Math.abs(currentBbox.minLon - p.source.bbox.minLon) < 1e-6 &&
      Math.abs(currentBbox.minLat - p.source.bbox.minLat) < 1e-6 &&
      Math.abs(currentBbox.maxLon - p.source.bbox.maxLon) < 1e-6 &&
      Math.abs(currentBbox.maxLat - p.source.bbox.maxLat) < 1e-6;

    if (!sameBbox) {
      setSwitchingId(p.id);
      setBbox(p.source.bbox, p.name);
      await generate();
      setSwitchingId(null);
    }
    loadProjectIntoStore(p);
    onClose();
  };

  const handleFork = (sourceId: string) => {
    const source = projects.find((p) => p.id === sourceId);
    if (!source) return;
    const fork = forkProject(source, genProjectId(), `${source.name} (fork)`);
    saveProject(fork);
    setProjects(listProjects());
    void openProject(fork);
  };

  return (
    <div className={cn("flex h-full flex-col overflow-hidden", className)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-medium text-fg">Your projects</p>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {projects.length === 0 ? (
          <p className="text-xs text-muted">
            No saved projects yet on this device. Generate a base world, make an edit, and hit Save to create one.
          </p>
        ) : (
          <ul className="space-y-2">
            {projects.map((p) => (
              <li
                key={p.id}
                className={cn(
                  "rounded-md border p-2",
                  p.id === currentProject?.id ? "border-fg" : "border-border"
                )}
              >
                <p className="truncate text-sm text-fg">{p.name}</p>
                <p className="text-[11px] text-subtle">
                  {new Date(p.metadata.updatedAt).toLocaleString()}
                  {p.metadata.forkedFrom && " · forked"}
                  {p.id === currentProject?.id && " · open"}
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={p.id === currentProject?.id || switchingId === p.id}
                    onClick={() => void openProject(p)}
                  >
                    {switchingId === p.id ? "Generating base world…" : "Open"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={switchingId !== null}
                    onClick={() => handleFork(p.id)}
                  >
                    Fork
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
