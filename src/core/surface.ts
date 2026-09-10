import type {
  Action,
  ActionResult,
  ControlOwner,
  Observation,
} from "./types.ts";

/**
 * Heterogeneity seam: web, legacy-web, and desktop adapters implement this.
 * Artifacts store intent (action + logical locator), never Playwright calls.
 */
export interface Surface {
  observe(): Promise<Observation>;
  act(action: Action): Promise<ActionResult>;
  screenshot(): Promise<Buffer>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  whoHasControl(): ControlOwner;
  close(): Promise<void>;
}

export function locatorLabel(locator: { by: string; role?: string; name?: string; text?: string; selector?: string }): string {
  if (locator.by === "role") return `${locator.role} "${locator.name ?? ""}"`;
  if (locator.by === "label") return `label "${locator.name ?? ""}"`;
  if (locator.by === "text") return `text "${locator.text ?? ""}"`;
  return `css ${locator.selector ?? ""}`;
}
