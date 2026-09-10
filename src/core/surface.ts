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
  sessionId(): string;
  observe(): Promise<Observation>;
  act(action: Action): Promise<ActionResult>;
  /** Operator-side act: allowed only while the human holds the lock on this same session. */
  actAsHuman(action: Action): Promise<ActionResult>;
  screenshot(): Promise<Buffer>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  whoHasControl(): ControlOwner;
  close(): Promise<void>;
}

export function locatorLabel(locator: {
  by: string;
  role?: string;
  name?: string;
  text?: string;
  selector?: string;
  cell?: string;
  row?: { matches: string };
}): string {
  if (locator.by === "cellInRow") {
    return `cellInRow "${locator.cell ?? locator.name ?? ""}" in ${locator.row?.matches ?? "row"}`;
  }
  if (locator.by === "role") return `${locator.role} "${locator.name ?? ""}"`;
  if (locator.by === "label") return `label "${locator.name ?? ""}"`;
  if (locator.by === "text") return `text "${locator.text ?? ""}"`;
  return `css ${locator.selector ?? ""}`;
}
