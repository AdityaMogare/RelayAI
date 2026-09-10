import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { OverlayConflictError } from "../core/errors.ts";
import { parseOverlay } from "./schema.ts";
import { resolveCapability, type OverlayStack, type ResolvedCapability, type RunOverlayParams } from "./resolve.ts";
import type { Capability } from "../core/types.ts";

export function overlayRoot(cwd = process.cwd()): string {
  return resolve(cwd, "overlays");
}

export function loadOverlayStack(
  vendorId: string,
  tenantId: string | undefined,
  root = overlayRoot(),
): OverlayStack {
  const stack: OverlayStack = {};
  const vendorPath = join(root, "vendors", `${vendorId}.yaml`);
  if (existsSync(vendorPath)) {
    stack.vendor = parseOverlay(parseYaml(readFileSync(vendorPath, "utf8")), vendorPath);
    stack.vendorPath = vendorPath;
  }
  if (!tenantId) return stack;
  const tenantPath = join(root, "tenants", `${tenantId}.yaml`);
  if (!existsSync(tenantPath)) return stack;
  const tenant = parseOverlay(parseYaml(readFileSync(tenantPath, "utf8")), tenantPath);
  if (tenant.vendorId !== vendorId) {
    throw new OverlayConflictError(
      `${tenantPath} is bound to ${tenant.vendorId}, not ${vendorId}.`,
    );
  }
  stack.tenant = tenant;
  stack.tenantPath = tenantPath;
  return stack;
}

export function bindTenant(
  capability: Capability,
  tenantId: string | undefined,
  run: RunOverlayParams = {},
  root = overlayRoot(),
): ResolvedCapability {
  return resolveCapability(capability, loadOverlayStack(capability.app.vendorId, tenantId, root), {
    ...run,
    tenantId,
  });
}
