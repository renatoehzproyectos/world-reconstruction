/**
 * The reference pane (spec §6) is the primary reconstruction instrument —
 * "look left, see the real building, edit right." What actually renders
 * there is a separate concern from the reconstruction editor; this
 * interface is the seam — swap the provider without touching anything in
 * reconstruction/ or the workspace shell.
 *
 * `PlaceholderReferenceProvider` (no imagery, an honest "not connected"
 * state) is the default. `GoogleStreetViewProvider`
 * (google-street-view.ts) is a real provider using the user's own API key
 * (reference/settings.ts) — chosen automatically once a key is saved, no
 * code changes needed. The spec originally said not to fabricate a Street
 * View integration without that key/decision; this is that decision,
 * made explicitly by the person using the app, with their own key, never
 * shipped or assumed by default.
 */

import { getGoogleMapsApiKey } from "./settings";
import { GoogleStreetViewProvider } from "./google-street-view";

export type ReferenceView = {
  lon: number;
  lat: number;
  /** Compass heading in degrees, 0 = north. */
  headingDeg: number;
  /** 0 = level, positive = looking up. */
  pitchDeg: number;
};

export type ReferenceAvailability =
  | { status: "unavailable"; reason: string }
  | { status: "available" };

export interface ReferenceProvider {
  readonly id: string;
  readonly label: string;
  checkAvailability(view: ReferenceView): Promise<ReferenceAvailability>;
  /**
   * Mount imagery/controls into `container`. Returns a cleanup function.
   * Providers own their own rendering (iframe, canvas, whatever their SDK
   * needs) rather than exposing a React component, so swapping providers
   * never touches workspace UI code.
   */
  mount(container: HTMLElement, view: ReferenceView): () => void;
}

/**
 * Honest placeholder: no imagery, shows the coordinates/heading and a
 * message explaining that no reference provider is connected. This is what
 * ships until a real provider (with its own API key / ToS acceptance) is
 * wired in — the workspace and reconstruction logic don't need to change
 * when that happens.
 */
export class PlaceholderReferenceProvider implements ReferenceProvider {
  readonly id = "placeholder";
  readonly label = "No reference connected";

  async checkAvailability(): Promise<ReferenceAvailability> {
    return { status: "unavailable", reason: "No street-level imagery provider is configured." };
  }

  mount(container: HTMLElement, view: ReferenceView): () => void {
    container.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;padding:24px;text-align:center;color:var(--color-muted, #888);";
    const title = document.createElement("div");
    title.textContent = "Reference imagery not connected";
    title.style.cssText = "font-weight:600;color:var(--color-fg, #ddd);";
    const coords = document.createElement("div");
    coords.textContent = `${view.lat.toFixed(6)}, ${view.lon.toFixed(6)} · heading ${Math.round(view.headingDeg)}°`;
    coords.style.cssText = "font-family:monospace;font-size:12px;";
    const hint = document.createElement("div");
    hint.textContent = "Open this location in Street View or a photo of the real place to reconstruct against it.";
    hint.style.cssText = "font-size:12px;max-width:32ch;";
    wrap.append(title, coords, hint);
    container.appendChild(wrap);
    return () => {
      container.innerHTML = "";
    };
  }
}

let activeProvider: ReferenceProvider | null = null;

/**
 * Picks GoogleStreetViewProvider when the user has saved their own API key
 * (see reference/settings.ts), otherwise the honest placeholder. Checked
 * fresh on every call rather than cached at module load, so saving a key
 * in Settings takes effect without a page reload — see
 * refreshReferenceProvider(), called by the settings panel right after save.
 */
export function getReferenceProvider(): ReferenceProvider {
  if (!activeProvider) activeProvider = resolveProvider();
  return activeProvider;
}

function resolveProvider(): ReferenceProvider {
  if (getGoogleMapsApiKey()) return new GoogleStreetViewProvider();
  return new PlaceholderReferenceProvider();
}

/** Call after saving/clearing the API key so the next mount picks up the change without a page reload. */
export function refreshReferenceProvider(): void {
  activeProvider = resolveProvider();
}

/** For swapping in a different provider entirely (e.g. Mapillary, a user's own photo set) later. */
export function setReferenceProvider(provider: ReferenceProvider): void {
  activeProvider = provider;
}
