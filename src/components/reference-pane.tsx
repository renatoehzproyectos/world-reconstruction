import { useEffect, useRef } from "react";
import { getReferenceProvider, type ReferenceHandle, type ReferenceView } from "@/lib/reference/provider";

type Props = {
  view: ReferenceView;
  className?: string;
  /**
   * Bump this to force a fresh mount — e.g. after the active provider
   * changes (saving/clearing an API key in Settings calls
   * refreshReferenceProvider(); the parent bumps this in response so the
   * pane actually switches from the placeholder to real imagery, or back,
   * without a page reload).
   */
  providerVersion?: number;
};

/**
 * Thin React shell around whatever ReferenceProvider is active. Deliberately
 * does not know anything about Street View, Mapillary, etc — see
 * src/lib/reference/provider.ts for why.
 *
 * Mounts once per providerVersion (not on every view change) and calls
 * handle.update() for position/heading/pitch changes after that — mounting
 * a Street View panorama is comparatively expensive, and the 3D camera can
 * report a new heading many times a second while orbiting (see
 * city-viewer.tsx's onCameraChange), so recreating the panorama on every
 * one of those would be both wasteful and visually janky.
 */
export function ReferencePane({ view, className, providerVersion = 0 }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<ReferenceHandle | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const provider = getReferenceProvider();
    const handle = provider.mount(host, viewRef.current);
    handleRef.current = handle;
    return () => {
      handle.dispose();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerVersion]);

  useEffect(() => {
    handleRef.current?.update(view);
  }, [view.lon, view.lat, view.headingDeg, view.pitchDeg]);

  return <div ref={hostRef} className={className} />;
}
