import { useEffect, useState } from "react";
import { getGoogleMapsApiKey, setGoogleMapsApiKey, clearGoogleMapsApiKey } from "@/lib/reference/settings";
import { refreshReferenceProvider } from "@/lib/reference/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
  onClose: () => void;
  /** Called after the API key is saved/cleared and the active provider refreshed, so the parent can force the reference pane to remount with the new provider. */
  onProviderChanged?: () => void;
  className?: string;
};

/** Masked preview of a saved key — never shows the whole value. */
function maskKey(key: string): string {
  if (key.length <= 4) return "••••";
  return `${"•".repeat(Math.min(20, Math.max(8, key.length - 4)))}${key.slice(-4)}`;
}

/**
 * Street View API Key configuration. The key is typed in by the person
 * using the app, stored in localStorage (reference/settings.ts — the same
 * persistence the rest of the app uses), loaded again automatically on the
 * next visit, and handed straight to Google's own SDK by the Street View
 * provider. It is never hardcoded, committed, or sent through this app's
 * own network calls, and the full value is never rendered anywhere else in
 * the UI.
 */
export function SettingsPanel({ onClose, onProviderChanged, className }: Props) {
  // Loaded on mount so a key saved in an earlier session is already there
  // after a refresh, with no re-entry.
  const [key, setKey] = useState("");
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "cleared">("idle");

  useEffect(() => {
    const existing = getGoogleMapsApiKey();
    setSavedKey(existing);
    if (existing) setKey(existing);
  }, []);

  const handleSave = () => {
    setGoogleMapsApiKey(key);
    setSavedKey(getGoogleMapsApiKey());
    refreshReferenceProvider();
    onProviderChanged?.();
    setReveal(false);
    setStatus("saved");
    setTimeout(() => setStatus("idle"), 1500);
  };

  const handleClear = () => {
    clearGoogleMapsApiKey();
    setKey("");
    setSavedKey(null);
    refreshReferenceProvider();
    onProviderChanged?.();
    setStatus("cleared");
    setTimeout(() => setStatus("idle"), 1500);
  };

  return (
    <div className={cn("flex h-full flex-col overflow-hidden", className)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-medium text-fg">Settings</p>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="space-y-3 px-4 py-4">
        <div>
          <Label className="mb-1.5 block text-xs">Street View API Key</Label>
          <p className="mb-2 text-[11px] text-subtle">
            Enables real Street View imagery in the reference pane. Needs the Maps JavaScript API and Street View
            Static API enabled on the key. Saved in this browser and loaded automatically next time — never sent
            anywhere except directly to Google&apos;s own SDK.
          </p>
          <div className="flex gap-2">
            <Input
              type={reveal ? "text" : "password"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={savedKey ? maskKey(savedKey) : "AIzaSy..."}
              autoComplete="off"
              spellCheck={false}
              aria-label="Street View API key"
              className="font-mono text-xs"
            />
            <Button variant="outline" size="sm" onClick={() => setReveal((v) => !v)} disabled={!key}>
              {reveal ? "Hide" : "Show"}
            </Button>
          </div>
          {savedKey && (
            <p className="mt-1.5 font-mono text-[11px] text-subtle">Saved key: {maskKey(savedKey)}</p>
          )}
        </div>

        <div className="flex gap-2">
          <Button size="sm" onClick={handleSave} disabled={!key.trim()}>
            {status === "saved" ? "Saved" : "Save"}
          </Button>
          <Button variant="outline" size="sm" onClick={handleClear} disabled={!savedKey && !key}>
            {status === "cleared" ? "Cleared" : "Clear"}
          </Button>
        </div>
      </div>
    </div>
  );
}
