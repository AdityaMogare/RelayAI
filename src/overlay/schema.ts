import { z } from "zod";
import { OverlayConflictError } from "../core/errors.ts";
import { checkpointSchema, exceptionalStateSchema } from "../artifact/schema.ts";

/**
 * Overlay files are intentionally small. They may remap copy and add detectors.
 * They must not mention risk, steps, sideEffects, id, or vendor binding — those
 * stay on the recorded artifact. `.strict()` is the conflict rule.
 */
export const overlaySchema = z
  .object({
    kind: z.enum(["vendor", "tenant"]),
    id: z.string().min(1),
    vendorId: z.string().min(1),
    notes: z.string().optional(),
    /** Accessible-name remaps. Confirm → Submit Request. Exact source strings. */
    copy: z.record(z.string().min(1), z.string().min(1)).optional(),
    exceptionalStates: z.array(exceptionalStateSchema).optional(),
    antiCheckpoints: z.array(checkpointSchema).optional(),
    entryCheckpoint: checkpointSchema.optional(),
    /** Default host; run `--base-url` still wins. */
    baseUrl: z.string().min(1).optional(),
    /** If set, only these capability ids receive the overlay. Omit = all vendor caps. */
    appliesTo: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type OverlayFile = z.infer<typeof overlaySchema>;

export const FORBIDDEN_OVERLAY_KEYS = [
  "risk",
  "steps",
  "sideEffects",
  "schemaVersion",
  "approval",
  "parameters",
  "outputs",
  "auth",
] as const;

export function parseOverlay(data: unknown, source = "overlay"): OverlayFile {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const key of FORBIDDEN_OVERLAY_KEYS) {
      if (key in (data as Record<string, unknown>)) {
        throw new OverlayConflictError(
          `${source} cannot set ${key}. Overlays remap copy and add detectors; they do not change risk, steps, or side effects.`,
        );
      }
    }
  }
  const parsed = overlaySchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "overlay";
    throw new OverlayConflictError(`${source}: ${path} ${issue?.message ?? "invalid overlay"}`);
  }
  return parsed.data;
}
