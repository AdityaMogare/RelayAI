import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability, LocatorHit, RunResult } from "../core/types.ts";
import type { Surface } from "../core/surface.ts";
import { EvidenceStore } from "../evidence/store.ts";
import { describeConfirmFix, type OverlayTrace, type ResolvedCapability } from "../overlay/resolve.ts";
import { ReplayEngine } from "./engine.ts";
import { probeApplicability, type ProbeResult } from "./probe.ts";

export type TenantPortability = {
  tenantId: string;
  overlayPath?: string;
  copy: Record<string, string>;
  overrides: OverlayTrace["overrides"];
  probe: ProbeResult;
  result: Pick<RunResult, "status" | "code" | "needsRediscovery" | "confidence">;
  matched: LocatorHit[];
  fellBack: LocatorHit[];
  confirmFix?: ReturnType<typeof describeConfirmFix>;
};

export type PortabilityReport = {
  capabilityId: string;
  tenants: TenantPortability[];
};

export async function runPortability(input: {
  capability: Capability;
  tenants: Array<{
    tenantId: string;
    resolved: ResolvedCapability;
    surface: Surface;
    inputs: Record<string, string>;
    baseUrl?: string;
    approveRisky?: boolean;
  }>;
}): Promise<PortabilityReport> {
  const tenants: TenantPortability[] = [];
  for (const tenant of input.tenants) {
    const probe = await probeApplicability(tenant.surface, tenant.resolved.capability, {
      baseUrl: tenant.baseUrl ?? tenant.resolved.trace.baseUrl,
      inputs: tenant.inputs,
    });
    const evidence = new EvidenceStore(
      `portability-${tenant.tenantId}`,
      mkdtempSync(join(tmpdir(), "relay-portability-")),
    );
    const result = await new ReplayEngine(tenant.surface, evidence).run(tenant.resolved.capability, {
      inputs: tenant.inputs,
      baseUrl: tenant.baseUrl ?? tenant.resolved.trace.baseUrl,
      approveRisky: tenant.approveRisky,
      tenantId: tenant.tenantId,
      overlayTrace: tenant.resolved.trace,
      probe: false,
    });
    const hits = result.locatorHits ?? [];
    tenants.push({
      tenantId: tenant.tenantId,
      overlayPath: tenant.resolved.trace.order.find((layer) => layer.layer === "tenant")?.path,
      copy: tenant.resolved.trace.copy,
      overrides: tenant.resolved.trace.overrides,
      probe,
      result: {
        status: result.status,
        code: result.code,
        needsRediscovery: result.needsRediscovery,
        confidence: result.confidence,
      },
      matched: hits.filter((hit) => hit.rank === 1),
      fellBack: hits.filter((hit) => hit.rank > 1),
      confirmFix: describeConfirmFix(tenant.resolved.trace),
    });
  }
  return { capabilityId: input.capability.id, tenants };
}

export function formatPortability(report: PortabilityReport): string {
  const lines = [`Portability: ${report.capabilityId} (one artifact, ${report.tenants.length} tenants)`, ""];
  for (const tenant of report.tenants) {
    lines.push(`## ${tenant.tenantId}${tenant.overlayPath ? `  (${tenant.overlayPath})` : ""}`);
    lines.push(`probe: ${tenant.probe.applicable ? "applicable" : "NOT applicable"} — ${tenant.probe.reason}`);
    lines.push(`replay: ${tenant.result.status}${tenant.result.code ? ` ${tenant.result.code}` : ""}  confidence=${tenant.result.confidence ?? 1}`);
    lines.push(`matched rank-1: ${tenant.matched.map((h) => `${h.stepId}:${h.locator.name ?? h.by}`).join(", ") || "(none)"}`);
    lines.push(`fell back: ${tenant.fellBack.map((h) => `${h.stepId} rank ${h.rank}`).join(", ") || "(none)"}`);
    const copy = Object.entries(tenant.copy);
    lines.push(
      `overlay copy: ${copy.length === 0 ? "(none — recorded names)" : copy.map(([from, to]) => `${from} → ${to}`).join(", ")}`,
    );
    if (tenant.confirmFix) {
      lines.push(`Confirm rename: ${tenant.confirmFix.change} in ${tenant.confirmFix.file} — ${tenant.confirmFix.who}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
