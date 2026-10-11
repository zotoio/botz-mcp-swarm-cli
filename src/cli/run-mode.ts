import type { Manifest } from "../engine/types/manifest.js";
import type { RunMode } from "../engine/types/run.js";

/** Same mode rules as the project studio: an explicit soak wins, otherwise a load profile runs as load. */
export function selectRunMode(manifest: Pick<Manifest, "load" | "soak">, soakRequested: boolean): RunMode {
  if (soakRequested || manifest.soak) return "soak";
  if (manifest.load && manifest.load.durationMs > 0) return "load";
  return "smoke";
}
