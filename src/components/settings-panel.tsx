import { useState } from "react";
import { getGoogleMapsApiKey, setGoogleMapsApiKey, clearGoogleMapsApiKey } from "@/lib/reference/settings";
import { refreshReferenceProvider } from "@/lib/reference/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
  onClose: () => void;
  className?: string;
};

/**
 * Textbox → Save forever → the reference pane starts using real Street
 * View imagery. "Save forever" means localStorage, same as every other
 * saved value in this app (see reference/settings.ts) — this is a value
 * the person typed in themselves and explicitly chose to persist, not
 * something the app assumes or ships with.
 */
export function SettingsPanel({ onClose, className }: Props) {
  const [key, setKey] = useState(() => getGoogleMapsApiKey() ?? "");
  const [saved, setSaved] = useState<"idle" | "saved" | "cleared">("idle");

  const handleSave = () => {
    setGoogleMapsApiKey(key);
    refreshReferenceProvider();
    setSaved("saved");
    setTimeout(() => setSaved("idle"), 1500);
  };

  const handleClear = () => {
    clearGoogleMapsApiKey();
    setKey("");
    refreshReferenceProvider();
    setSaved("cleared");
    setTimeout(() => setSaved("idle"), 1500);
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
          <Label className="mb-1.5 block text-xs">Google Maps API key</Label>
          <p className="mb-2 text-[11px] text-subtle">
            Enables real Street View imagery in the reference pane. Needs the Maps JavaScript API and Street View
            Static API enabled on the key. Stored only in this browser — never sent anywhere except directly to
            Google's own SDK.
          </p>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="AIzaSy..."
            autoComplete="off"
            className="font-mono text-xs"
          />
        </div>

        <div className="flex gap-2">
          <Button size="sm" onClick={handleSave} disabled={!key.trim()}>
            {saved === "saved" ? "Saved" : "Save forever"}
          </Button>
          <Button variant="outline" size="sm" onClick={handleClear}>
            {saved === "cleared" ? "Cleared" : "Clear"}
          </Button>
        </div>
      </div>
    </div>
  );
}
