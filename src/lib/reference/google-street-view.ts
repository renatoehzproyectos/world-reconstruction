import type { ReferenceAvailability, ReferenceHandle, ReferenceProvider, ReferenceView } from "./provider";
import { getGoogleMapsApiKey } from "./settings";

/**
 * Minimal ambient shape for the pieces of the Google Maps JS SDK this file
 * actually uses. Not the full @types/google.maps surface — just enough to
 * avoid `any` on the calls we make. The SDK attaches itself to
 * `window.google` once its script tag loads; nothing here imports it as a
 * module.
 */
declare global {
  interface Window {
    google?: {
      maps: {
        StreetViewPanorama: new (
          container: HTMLElement,
          opts: {
            position: { lat: number; lng: number };
            pov: { heading: number; pitch: number };
            zoom?: number;
            fullscreenControl?: boolean;
            addressControl?: boolean;
            motionTracking?: boolean;
          }
        ) => {
          setPosition: (p: { lat: number; lng: number }) => void;
          setPov: (p: { heading: number; pitch: number }) => void;
        };
        StreetViewService: new () => {
          getPanorama: (
            request: { location: { lat: number; lng: number }; radius: number },
            callback: (data: unknown, status: string) => void
          ) => void;
        };
        StreetViewStatus: { OK: string };
      };
    };
    initWorldReconstructionStreetView?: () => void;
  }
}

let loadPromise: Promise<void> | null = null;

/**
 * Loads the Maps JS API script exactly once per page load (cached in
 * loadPromise), using the callback pattern — same approach as the
 * reference test file this was built from. Rejects if the script itself
 * fails to load (bad key, network block); a bad-but-loadable key still
 * resolves here and only fails later, inside the SDK's own calls.
 */
function loadGoogleMapsScript(apiKey: string): Promise<void> {
  if (window.google?.maps) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    window.initWorldReconstructionStreetView = () => resolve();
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&callback=initWorldReconstructionStreetView`;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      loadPromise = null;
      reject(
        new Error(
          "Google Maps failed to load. Check the API key and that it has the Maps JavaScript API and Street View Static API enabled."
        )
      );
    };
    document.head.appendChild(script);
  });
  return loadPromise;
}

export class GoogleStreetViewProvider implements ReferenceProvider {
  readonly id = "google-street-view";
  readonly label = "Google Street View";

  async checkAvailability(view: ReferenceView): Promise<ReferenceAvailability> {
    const key = getGoogleMapsApiKey();
    if (!key) return { status: "unavailable", reason: "No Google Maps API key saved yet — add one in Settings." };

    try {
      await loadGoogleMapsScript(key);
    } catch (err) {
      return { status: "unavailable", reason: err instanceof Error ? err.message : "Failed to load Google Maps." };
    }

    if (!window.google?.maps) {
      return { status: "unavailable", reason: "Google Maps loaded but the SDK object is missing — unexpected." };
    }

    // Confirm imagery actually exists near this point, not just that the
    // key/SDK work — a location with no Street View coverage should say so
    // rather than mount a panorama that silently shows nothing useful.
    return new Promise((resolve) => {
      const svc = new window.google!.maps.StreetViewService();
      svc.getPanorama({ location: { lat: view.lat, lng: view.lon }, radius: 75 }, (_data, status) => {
        if (status === window.google!.maps.StreetViewStatus.OK) {
          resolve({ status: "available" });
        } else {
          resolve({ status: "unavailable", reason: "No Street View imagery found within 75m of this location." });
        }
      });
    });
  }

  mount(container: HTMLElement, view: ReferenceView): ReferenceHandle {
    let cancelled = false;
    let panorama: { setPosition: (p: { lat: number; lng: number }) => void; setPov: (p: { heading: number; pitch: number }) => void } | null = null;
    // Buffers the most recent view if update() is called before the SDK
    // finishes loading, so an early camera move while Street View is still
    // mounting isn't silently dropped.
    let pendingView: ReferenceView | null = null;
    container.innerHTML = "";

    const key = getGoogleMapsApiKey();
    if (!key) {
      renderMessage(container, "No Google Maps API key saved. Add one in Settings to see real Street View imagery here.");
      return {
        update: () => {},
        dispose: () => {
          container.innerHTML = "";
        },
      };
    }

    loadGoogleMapsScript(key)
      .then(() => {
        if (cancelled || !window.google?.maps) return;
        const initialView = pendingView ?? view;
        panorama = new window.google.maps.StreetViewPanorama(container, {
          position: { lat: initialView.lat, lng: initialView.lon },
          pov: { heading: initialView.headingDeg, pitch: initialView.pitchDeg },
          zoom: 1,
          fullscreenControl: true,
          addressControl: true,
          motionTracking: false,
        });
      })
      .catch((err: Error) => {
        if (!cancelled) renderMessage(container, err.message);
      });

    return {
      update: (nextView: ReferenceView) => {
        if (panorama) {
          panorama.setPosition({ lat: nextView.lat, lng: nextView.lon });
          panorama.setPov({ heading: nextView.headingDeg, pitch: nextView.pitchDeg });
        } else {
          // SDK/panorama not ready yet — remember it for the .then() above.
          pendingView = nextView;
        }
      },
      dispose: () => {
        cancelled = true;
        container.innerHTML = "";
      },
    };
  }
}

function renderMessage(container: HTMLElement, message: string): void {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "display:flex;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center;color:var(--color-muted, #888);font-size:13px;";
  wrap.textContent = message;
  container.appendChild(wrap);
}
