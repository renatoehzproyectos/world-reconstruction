import type { ReconstructionProject } from "@/lib/reconstruction/types";

/**
 * Save/load the reconstruction STATE, never a baked snapshot (spec §28).
 * Given the same base data + the same deltas, applyReconstruction() always
 * produces the same scene, so this JSON blob is the entire source of truth —
 * GLB is an export target, not storage.
 *
 * MVP storage: localStorage, keyed by project id. This satisfies spec §17E
 * ("save reconstruction project locally/persistently ... reload project").
 * Swapping this for PGlite/server persistence later only touches this file —
 * everything else in reconstruction/ only depends on ReconstructionProject.
 */

const STORAGE_PREFIX = "world-reconstruction:project:";
const INDEX_KEY = "world-reconstruction:project-index";

const PROJECT_FORMAT_VERSION = 1;

type StoredEnvelope = {
  formatVersion: number;
  project: ReconstructionProject;
};

export function saveProject(project: ReconstructionProject): void {
  const envelope: StoredEnvelope = { formatVersion: PROJECT_FORMAT_VERSION, project };
  localStorage.setItem(STORAGE_PREFIX + project.id, JSON.stringify(envelope));

  const index = listProjectIds();
  if (!index.includes(project.id)) {
    localStorage.setItem(INDEX_KEY, JSON.stringify([...index, project.id]));
  }
}

export function loadProject(id: string): ReconstructionProject | null {
  const raw = localStorage.getItem(STORAGE_PREFIX + id);
  if (!raw) return null;
  try {
    const envelope = JSON.parse(raw) as StoredEnvelope;
    if (envelope.formatVersion !== PROJECT_FORMAT_VERSION) {
      console.warn(
        `[project] Stored project "${id}" has format version ${envelope.formatVersion}, expected ${PROJECT_FORMAT_VERSION}. Loading as-is; migration not yet implemented.`,
      );
    }
    return envelope.project;
  } catch (err) {
    console.error(`[project] Failed to parse stored project "${id}":`, err);
    return null;
  }
}

export function deleteProject(id: string): void {
  localStorage.removeItem(STORAGE_PREFIX + id);
  localStorage.setItem(INDEX_KEY, JSON.stringify(listProjectIds().filter((p) => p !== id)));
}

export function listProjectIds(): string[] {
  const raw = localStorage.getItem(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function listProjects(): ReconstructionProject[] {
  return listProjectIds()
    .map(loadProject)
    .filter((p): p is ReconstructionProject => p !== null);
}

export function exportProjectJson(project: ReconstructionProject): string {
  return JSON.stringify({ formatVersion: PROJECT_FORMAT_VERSION, project } satisfies StoredEnvelope, null, 2);
}

export function importProjectJson(json: string): ReconstructionProject {
  const envelope = JSON.parse(json) as StoredEnvelope;
  return envelope.project;
}
