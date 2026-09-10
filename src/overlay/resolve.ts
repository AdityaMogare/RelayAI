import type { Capability } from "../core/types.ts";
import { OverlayConflictError } from "../core/errors.ts";
import { applyCopy } from "./copy.ts";
import type { OverlayFile } from "./schema.ts";

export type OverlayLayerKind = "base" | "vendor" | "tenant" | "run";

export type OverlayOverride = {
  layer: OverlayLayerKind;
  kind: "copy" | "detector" | "antiCheckpoint" | "entry" | "baseUrl";
  from?: string;
  to?: string;
  detail?: string;
};

export type OverlayTrace = {
  /** Later layers win. Overlays cannot change risk, steps, or sideEffects. */
  order: Array<{ layer: OverlayLayerKind; id: string; path?: string }>;
  copy: Record<string, string>;
  overrides: OverlayOverride[];
  baseUrl?: string;
};

export type ResolvedCapability = {
  capability: Capability;
  trace: OverlayTrace;
};

export type RunOverlayParams = {
  baseUrl?: string;
  tenantId?: string;
};

/**
 * Resolution order (later wins):
 *
 *   base artifact  →  vendor pack  →  tenant overlay  →  run params
 *
 * Conflict rules:
 *   - Copy, extra detectors, anti-checkpoints, entry checkpoint: later layer wins.
 *   - Detectors/anti-checkpoints append; they do not delete vendor/base ones.
 *   - Overlays cannot change id, vendorId, surfaceKind, risk, action, sideEffects, approval.
 *   - Run params may set baseUrl / inputs / tenantId only — never locators.
 */
export const OVERLAY_ORDER_DIAGRAM = `
base artifact          recorded locators, risk, steps, side effects
        │
        ▼  copy aliases + extra detectors (cannot change risk)
vendor pack            overlays/vendors/<vendorId>.yaml
        │
        ▼  copy remaps + extra detectors (cannot change risk)
tenant overlay         overlays/tenants/<tenantId>.yaml
        │
        ▼  --base-url --input --tenant (cannot change locators)
run params
`.trim();

export type OverlayStack = {
  vendor?: OverlayFile;
  vendorPath?: string;
  tenant?: OverlayFile;
  tenantPath?: string;
};

export function resolveCapability(
  base: Capability,
  stack: OverlayStack = {},
  run: RunOverlayParams = {},
): ResolvedCapability {
  if (stack.vendor && stack.vendor.vendorId !== base.app.vendorId) {
    throw new OverlayConflictError(
      `Vendor pack ${stack.vendor.id} is for ${stack.vendor.vendorId}, artifact is ${base.app.vendorId}.`,
    );
  }
  if (stack.tenant && stack.tenant.vendorId !== base.app.vendorId) {
    throw new OverlayConflictError(
      `Tenant overlay ${stack.tenant.id} is for ${stack.tenant.vendorId}, artifact is ${base.app.vendorId}.`,
    );
  }
  if (stack.vendor && stack.vendor.kind !== "vendor") {
    throw new OverlayConflictError(`Expected a vendor pack, got kind=${stack.vendor.kind}.`);
  }
  if (stack.tenant && stack.tenant.kind !== "tenant") {
    throw new OverlayConflictError(`Expected a tenant overlay, got kind=${stack.tenant.kind}.`);
  }

  const tenantApplies =
    !stack.tenant?.appliesTo || stack.tenant.appliesTo.includes(base.id) ? stack.tenant : undefined;

  const copy: Record<string, string> = {
    ...(stack.vendor?.copy ?? {}),
    ...(tenantApplies?.copy ?? {}),
  };
  const overrides: OverlayOverride[] = [];
  const order: OverlayTrace["order"] = [{ layer: "base", id: base.id }];

  let capability = applyCopy(base, copy);

  if (stack.vendor) {
    order.push({ layer: "vendor", id: stack.vendor.id, path: stack.vendorPath });
    for (const [from, to] of Object.entries(stack.vendor.copy ?? {})) {
      overrides.push({ layer: "vendor", kind: "copy", from, to });
    }
    capability = mergeDetectors(capability, stack.vendor, "vendor", overrides);
  }

  if (tenantApplies) {
    order.push({ layer: "tenant", id: tenantApplies.id, path: stack.tenantPath });
    for (const [from, to] of Object.entries(tenantApplies.copy ?? {})) {
      overrides.push({ layer: "tenant", kind: "copy", from, to });
    }
    capability = mergeDetectors(capability, tenantApplies, "tenant", overrides);
  }

  const baseUrl = run.baseUrl ?? tenantApplies?.baseUrl ?? stack.vendor?.baseUrl;
  if (baseUrl) {
    const layer: OverlayLayerKind = run.baseUrl ? "run" : tenantApplies?.baseUrl ? "tenant" : "vendor";
    overrides.push({ layer, kind: "baseUrl", to: baseUrl });
  }
  order.push({ layer: "run", id: run.tenantId ?? "run" });

  assertUnchangedSafety(base, capability);

  return {
    capability,
    trace: { order, copy, overrides, baseUrl },
  };
}

function mergeDetectors(
  capability: Capability,
  overlay: OverlayFile,
  layer: OverlayLayerKind,
  overrides: OverlayOverride[],
): Capability {
  const next = structuredClone(capability);
  if (overlay.exceptionalStates?.length) {
    next.exceptionalStates = [...next.exceptionalStates, ...overlay.exceptionalStates];
    for (const state of overlay.exceptionalStates) {
      overrides.push({
        layer,
        kind: "detector",
        detail: `${state.code}: ${state.detect.textIncludes ?? state.detect.dialogTitle ?? state.detect.urlIncludes}`,
      });
    }
  }
  if (overlay.antiCheckpoints?.length) {
    next.antiCheckpoints = [...(next.antiCheckpoints ?? []), ...overlay.antiCheckpoints];
    for (const check of overlay.antiCheckpoints) {
      overrides.push({ layer, kind: "antiCheckpoint", detail: `${check.kind} ${check.expect}` });
    }
  }
  if (overlay.entryCheckpoint) {
    next.preconditions.entryCheckpoint = overlay.entryCheckpoint;
    overrides.push({
      layer,
      kind: "entry",
      to: `${overlay.entryCheckpoint.kind} ${overlay.entryCheckpoint.expect}`,
    });
  }
  return next;
}

function assertUnchangedSafety(base: Capability, resolved: Capability): void {
  if (resolved.id !== base.id) throw new OverlayConflictError("Overlay changed capability id.");
  if (resolved.app.vendorId !== base.app.vendorId) {
    throw new OverlayConflictError("Overlay changed vendorId.");
  }
  if (resolved.app.surfaceKind !== base.app.surfaceKind) {
    throw new OverlayConflictError("Overlay changed surfaceKind.");
  }
  if (resolved.sideEffects.kind !== base.sideEffects.kind) {
    throw new OverlayConflictError("Overlay changed sideEffects.kind.");
  }
  if (resolved.steps.length !== base.steps.length) {
    throw new OverlayConflictError("Overlay changed the step list.");
  }
  for (let i = 0; i < base.steps.length; i += 1) {
    const before = base.steps[i]!;
    const after = resolved.steps[i]!;
    if (after.risk !== before.risk || after.action !== before.action || after.id !== before.id) {
      throw new OverlayConflictError(
        `Overlay changed step ${before.id} action/risk. Copy remaps names; they do not reclassify Confirm as safe.`,
      );
    }
  }
}

export function describeConfirmFix(trace: OverlayTrace): { file: string; who: string; change: string } | undefined {
  const hit = [...trace.overrides].reverse().find((item) => item.kind === "copy" && item.from === "Confirm");
  if (!hit) return undefined;
  const file =
    hit.layer === "tenant"
      ? `overlays/tenants/${trace.order.find((l) => l.layer === "tenant")?.id ?? "tenant"}.yaml`
      : `overlays/vendors/${trace.order.find((l) => l.layer === "vendor")?.id ?? "vendor"}.yaml`;
  return {
    file,
    who: hit.layer === "tenant" ? "tenant ops (edit the overlay; do not re-record)" : "vendor pack owner",
    change: `copy: { Confirm: ${JSON.stringify(hit.to)} }`,
  };
}
