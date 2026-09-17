import { useEffect, useMemo, useState } from "react";
import { CityViewer } from "@/components/city-viewer";
import { ReferencePane } from "@/components/reference-pane";
import { BuildingEditPanel } from "@/components/building-edit-panel";
import { RoadEditPanel } from "@/components/road-edit-panel";
import { TerrainTool, makeTerrainEditFromClick, type TerrainBrush } from "@/components/terrain-tool";
import { ObjectPlacementTool } from "@/components/object-placement-tool";
import { SidewalkTool } from "@/components/sidewalk-tool";
import { SidewalkEditPanel } from "@/components/sidewalk-edit-panel";
import { HistoryPanel } from "@/components/history-panel";
import { MaterialsLibraryPanel } from "@/components/materials-library-panel";
import { ProjectBrowserPanel } from "@/components/project-browser-panel";
import { SettingsPanel } from "@/components/settings-panel";
import { useStudio } from "@/store/studio";
import { useReconstructionStore } from "@/lib/reconstruction/store";
import { createProject, type SceneObjectKind } from "@/lib/reconstruction/types";
import { materializeCityData, applyReconstruction, applyTerrainEditsToGrid } from "@/lib/reconstruction/apply";
import { baseRevisionFor, elevationSourceFrom, projectIdFor } from "@/lib/reconstruction/bridge";
import { loadProject, saveProject } from "@/lib/project/serialize";
import { bboxCenter } from "@/lib/city/geo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CityData } from "@/lib/city/types";
import type { HeightGrid } from "@/lib/city/elevation";

type Tool = "select" | "terrain" | "road" | "object" | "sidewalk" | "sidewalk-edit";

/**
 * The reconstruction editor (spec §2/§3): reference pane on the left,
 * editable 3D reconstruction on the right. Only meaningful once base-world
 * generation (useStudio) has produced a CityData — see studio-shell.tsx /
 * StudioShell for the generation step this sits downstream of.
 */
export function ReconstructionWorkspace({ className }: { className?: string }) {
  const city = useStudio((s) => s.city);
  const status = useStudio((s) => s.status);
  const layers = useStudio((s) => s.layers);
  const treeDensity = useStudio((s) => s.treeDensity);
  const satellite = useStudio((s) => s.satellite);
  const landCover = useStudio((s) => s.landCover);
  const autoRotate = useStudio((s) => s.autoRotate);

  const project = useReconstructionStore((s) => s.project);
  const loadProjectIntoStore = useReconstructionStore((s) => s.loadProject);
  const addTerrainEdit = useReconstructionStore((s) => s.addTerrainEdit);
  const addObject = useReconstructionStore((s) => s.addObject);
  const addSidewalk = useReconstructionStore((s) => s.addSidewalk);

  const [tool, setTool] = useState<Tool>("select");
  const [selectedBuildingIds, setSelectedBuildingIds] = useState<string[]>([]);
  const [selectedRoadId, setSelectedRoadId] = useState<string | null>(null);
  const [selectedSidewalkId, setSelectedSidewalkId] = useState<string | null>(null);
  const [exportFn, setExportFn] = useState<(() => Promise<void>) | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saved">("idle");
  const [baseGrid, setBaseGrid] = useState<HeightGrid | null>(null);
  const [terrainBrush, setTerrainBrush] = useState<TerrainBrush>({ kind: "raise", radius: 12, amount: 2 });
  const [objectKind, setObjectKind] = useState<SceneObjectKind>("tree");
  const [sidewalkWidth, setSidewalkWidth] = useState(2);
  const [sidewalkPending, setSidewalkPending] = useState<{ x: number; z: number }[]>([]);
  const [openPanel, setOpenPanel] = useState<"none" | "history" | "materials" | "projects" | "settings">("none");

  useEffect(() => {
    if (!city || status !== "ready") return;
    const id = projectIdFor(city);
    if (project?.id === id) return;
    const existing = loadProject(id);
    if (existing) {
      loadProjectIntoStore(existing);
      return;
    }
    const fresh = createProject({
      id,
      name: city.placeName || "Untitled reconstruction",
      bbox: city.bbox,
      origin: city.origin,
      overtureRelease: baseRevisionFor(city).split("@")[0],
      elevationSource: elevationSourceFrom(null),
      baseRevision: baseRevisionFor(city),
    });
    loadProjectIntoStore(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city, status]);

  const reconstructedCity: CityData | null = useMemo(() => {
    if (!city) return null;
    if (!project) return city;
    return materializeCityData(city, project.deltas);
  }, [city, project]);

  const reconstructedWorld = useMemo(() => {
    if (!city || !project) return null;
    return applyReconstruction(city, project.deltas);
  }, [city, project]);

  const selectedBuildings = useMemo(() => {
    if (!reconstructedWorld || selectedBuildingIds.length === 0) return [];
    const ids = new Set(selectedBuildingIds);
    return reconstructedWorld.buildings.filter((b) => b.id && ids.has(b.id));
  }, [reconstructedWorld, selectedBuildingIds]);

  const selectedRoad = useMemo(() => {
    if (!reconstructedWorld || !selectedRoadId) return null;
    return reconstructedWorld.roads.find((r) => r.id === selectedRoadId) ?? null;
  }, [reconstructedWorld, selectedRoadId]);

  const selectedSidewalk = useMemo(() => {
    if (!project || !selectedSidewalkId) return null;
    return project.deltas.sidewalks.find((s) => s.id === selectedSidewalkId) ?? null;
  }, [project, selectedSidewalkId]);

  const [cameraHeadingDeg, setCameraHeadingDeg] = useState(0);
  const [cameraPitchDeg, setCameraPitchDeg] = useState(0);
  const [referenceProviderVersion, setReferenceProviderVersion] = useState(0);

  const referenceView = useMemo(() => {
    if (!city) return null;
    const center = bboxCenter(city.bbox);
    return { lon: center.lon, lat: center.lat, headingDeg: cameraHeadingDeg, pitchDeg: cameraPitchDeg };
  }, [city, cameraHeadingDeg, cameraPitchDeg]);

  const editedGrid: HeightGrid | null | undefined = useMemo(() => {
    if (!baseGrid) return undefined;
    if (!project || project.deltas.terrainEdits.length === 0) return baseGrid;
    return applyTerrainEditsToGrid(baseGrid, project.deltas.terrainEdits);
  }, [baseGrid, project]);

  const editCount = project
    ? project.deltas.buildingEdits.length +
      project.deltas.roadEdits.length +
      project.deltas.terrainEdits.length +
      project.deltas.objects.length +
      project.deltas.sidewalks.length
    : 0;

  const handleTerrainClick = (localX: number, localZ: number) => {
    addTerrainEdit(makeTerrainEditFromClick(terrainBrush, localX, localZ));
  };

  const handlePlaceObject = (localX: number, localZ: number) => {
    addObject({ kind: objectKind, localX, localZ, rotationDeg: 0, scale: 1 });
  };

  const handleSidewalkClick = (localX: number, localZ: number) => {
    setSidewalkPending((prev) => [...prev, { x: localX, z: localZ }]);
  };

  const handleFinishSidewalk = () => {
    if (sidewalkPending.length < 2) return;
    addSidewalk(
      sidewalkPending.map((p) => [p.x, p.z] as [number, number]),
      sidewalkWidth
    );
    setSidewalkPending([]);
  };

  const handleSave = () => {
    if (!project) return;
    saveProject(project);
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1500);
  };

  const selectTool = (next: Tool) => {
    setTool(next);
    if (next !== "select") {
      setSelectedBuildingIds([]);
      setSelectedRoadId(null);
    }
    if (next !== "sidewalk-edit") {
      setSelectedSidewalkId(null);
    }
    if (next !== "sidewalk") {
      setSidewalkPending([]);
    }
  };

  if (!city || status !== "ready") {
    return (
      <div className={cn("flex h-full items-center justify-center text-sm text-muted", className)}>
        Generate a base world first, then open the reconstruction workspace.
      </div>
    );
  }

  const pickMode =
    tool === "terrain"
      ? "terrain"
      : tool === "road"
        ? "road"
        : tool === "object"
          ? "object"
          : tool === "sidewalk"
            ? "sidewalk"
            : tool === "sidewalk-edit"
              ? "sidewalk-edit"
              : "building";

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="min-w-0 truncate text-sm font-medium text-fg">
          {project?.name ?? city.placeName}
          {project && (
            <span className="ml-2 font-mono text-[11px] text-subtle">
              {editCount} edit{editCount !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            <Button variant={tool === "select" ? "secondary" : "ghost"} size="sm" onClick={() => selectTool("select")}>
              Select
            </Button>
            <Button variant={tool === "terrain" ? "secondary" : "ghost"} size="sm" onClick={() => selectTool("terrain")}>
              Terrain
            </Button>
            <Button variant={tool === "road" ? "secondary" : "ghost"} size="sm" onClick={() => selectTool("road")}>
              Roads
            </Button>
            <Button variant={tool === "object" ? "secondary" : "ghost"} size="sm" onClick={() => selectTool("object")}>
              Objects
            </Button>
            <Button
              variant={tool === "sidewalk" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => selectTool("sidewalk")}
            >
              Sidewalks
            </Button>
            <Button
              variant={tool === "sidewalk-edit" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => selectTool("sidewalk-edit")}
            >
              Edit sidewalks
            </Button>
          </div>
          <Button variant="outline" size="sm" onClick={handleSave} disabled={!project}>
            {saveState === "saved" ? "Saved" : "Save"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpenPanel((v) => (v === "history" ? "none" : "history"))}
            disabled={!project}
          >
            History
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpenPanel((v) => (v === "materials" ? "none" : "materials"))}
            disabled={!project}
          >
            Materials
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpenPanel((v) => (v === "projects" ? "none" : "projects"))}
          >
            Projects
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpenPanel((v) => (v === "settings" ? "none" : "settings"))}
          >
            Settings
          </Button>
          <Button variant="secondary" size="sm" onClick={() => exportFn?.()} disabled={!exportFn}>
            Export GLB
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
        <div className="relative min-h-0 border-b border-border md:border-b-0 md:border-r">
          {referenceView && (
            <ReferencePane view={referenceView} providerVersion={referenceProviderVersion} className="h-full w-full" />
          )}
        </div>

        <div className="relative min-h-0">
          <CityViewer
            city={reconstructedCity}
            autoRotate={autoRotate}
            layers={layers}
            treeDensity={treeDensity}
            satellite={satellite}
            landCover={landCover}
            onReady={() => {}}
            onError={() => {}}
            onExportReady={setExportFn}
            onSelectBuilding={(sourceId, _featureIndex, additive) => {
              setSelectedBuildingIds((prev) => {
                if (!sourceId) return additive ? prev : [];
                if (!additive) return [sourceId];
                return prev.includes(sourceId) ? prev.filter((id) => id !== sourceId) : [...prev, sourceId];
              });
            }}
            selectedSourceIds={selectedBuildingIds}
            onSelectRoad={(sourceId) => setSelectedRoadId(sourceId ?? null)}
            selectedRoadSourceId={selectedRoadId}
            pickMode={pickMode}
            onTerrainClick={handleTerrainClick}
            onPlaceObject={handlePlaceObject}
            onSidewalkClick={handleSidewalkClick}
            onSelectSidewalk={(sourceId) => setSelectedSidewalkId(sourceId ?? null)}
            onCameraChange={(heading, pitch) => {
              setCameraHeadingDeg(heading);
              setCameraPitchDeg(pitch);
            }}
            externalHeightGrid={editedGrid}
            objects={project?.deltas.objects}
            sidewalks={project?.deltas.sidewalks}
            onHeightGrid={(grid) => {
              setBaseGrid((prev) => prev ?? grid);
            }}
          />

          {tool === "terrain" && (
            <div className="absolute left-3 top-3 w-[min(85vw,280px)]">
              <TerrainTool
                active
                brush={terrainBrush}
                onBrushChange={setTerrainBrush}
                onToggle={() => selectTool("select")}
              />
            </div>
          )}

          {tool === "object" && (
            <div className="absolute left-3 top-3 w-[min(85vw,280px)]">
              <ObjectPlacementTool
                active
                kind={objectKind}
                onKindChange={setObjectKind}
                onToggle={() => selectTool("select")}
              />
            </div>
          )}

          {tool === "sidewalk" && (
            <div className="absolute left-3 top-3 w-[min(85vw,280px)]">
              <SidewalkTool
                active
                onToggle={() => selectTool("select")}
                width={sidewalkWidth}
                onWidthChange={setSidewalkWidth}
                pendingPoints={sidewalkPending}
                onFinish={handleFinishSidewalk}
                onCancelPending={() => setSidewalkPending([])}
              />
            </div>
          )}

          {openPanel === "history" && (
            <div className="absolute inset-y-0 right-0 z-10 w-[min(90vw,340px)] border-l border-border bg-surface/95 backdrop-blur">
              <HistoryPanel onClose={() => setOpenPanel("none")} className="h-full" />
            </div>
          )}

          {openPanel === "materials" && (
            <div className="absolute inset-y-0 right-0 z-10 w-[min(90vw,340px)] border-l border-border bg-surface/95 backdrop-blur">
              <MaterialsLibraryPanel onClose={() => setOpenPanel("none")} className="h-full" />
            </div>
          )}

          {openPanel === "projects" && (
            <div className="absolute inset-y-0 right-0 z-10 w-[min(90vw,340px)] border-l border-border bg-surface/95 backdrop-blur">
              <ProjectBrowserPanel onClose={() => setOpenPanel("none")} className="h-full" />
            </div>
          )}

          {openPanel === "settings" && (
            <div className="absolute inset-y-0 right-0 z-10 w-[min(90vw,340px)] border-l border-border bg-surface/95 backdrop-blur">
              <SettingsPanel
                onClose={() => setOpenPanel("none")}
                onProviderChanged={() => setReferenceProviderVersion((v) => v + 1)}
                className="h-full"
              />
            </div>
          )}

          {openPanel === "none" && tool === "select" && selectedBuildingIds.length > 0 && (
            <div className="absolute inset-y-0 right-0 w-[min(90vw,340px)] border-l border-border bg-surface/95 backdrop-blur">
              <BuildingEditPanel
                buildings={selectedBuildings}
                sourceIds={selectedBuildingIds}
                onClose={() => setSelectedBuildingIds([])}
                className="h-full"
              />
            </div>
          )}

          {openPanel === "none" && tool === "road" && (
            <div className="absolute inset-y-0 right-0 w-[min(90vw,340px)] border-l border-border bg-surface/95 backdrop-blur">
              <RoadEditPanel
                road={selectedRoad}
                sourceId={selectedRoadId}
                onClose={() => setSelectedRoadId(null)}
                className="h-full"
              />
            </div>
          )}

          {openPanel === "none" && tool === "sidewalk-edit" && (
            <div className="absolute inset-y-0 right-0 w-[min(90vw,340px)] border-l border-border bg-surface/95 backdrop-blur">
              <SidewalkEditPanel
                sidewalk={selectedSidewalk}
                sourceId={selectedSidewalkId}
                onClose={() => setSelectedSidewalkId(null)}
                className="h-full"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
