import { useEffect, useRef } from "react";
import { getReferenceProvider, type ReferenceView } from "@/lib/reference/provider";

type Props = {
  view: ReferenceView;
  className?: string;
};

/**
 * Thin React shell around whatever ReferenceProvider is active. Deliberately
 * does not know anything about Street View, Mapillary, etc — see
 * src/lib/reference/provider.ts for why.
 */
export function ReferencePane({ view, className }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const provider = getReferenceProvider();
    const cleanup = provider.mount(host, view);
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.lon, view.lat, view.headingDeg, view.pitchDeg]);

  return <div ref={hostRef} className={className} />;
}
