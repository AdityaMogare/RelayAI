import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Capability, EvidenceEvent, InterventionRequest, Observation, RunResult } from "../core/types.ts";
import { contextFromCapability, notePiiValue, redactDeep, type RedactionContext } from "../policy/redact.ts";
import { publicObservation } from "./observe.ts";

export class EvidenceStore {
  readonly dir: string;
  private ctx: RedactionContext = { piiFields: new Set(), piiValues: [] };

  constructor(runId: string, root = resolve(process.cwd(), "evidence")) {
    this.dir = join(root, runId);
    mkdirSync(this.dir, { recursive: true });
  }

  classify(capability: Capability): void {
    this.ctx = contextFromCapability(capability);
  }

  notePii(raw: string | undefined): void {
    notePiiValue(this.ctx, raw);
  }

  event(kind: string, data: Record<string, unknown>): void {
    const event: EvidenceEvent = {
      at: new Date().toISOString(),
      runId: this.dir.split("/").pop() ?? "run",
      kind,
      data: redactDeep(data, this.ctx) as Record<string, unknown>,
    };
    appendFileSync(join(this.dir, "log.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  }

  async saveScreenshot(name: string, bytes: Buffer): Promise<string> {
    const path = join(this.dir, name);
    writeFileSync(path, bytes);
    return path;
  }

  saveJson(name: string, value: unknown): string {
    const path = join(this.dir, name);
    writeFileSync(path, `${JSON.stringify(redactDeep(value, this.ctx), null, 2)}\n`, "utf8");
    return path;
  }

  saveObservation(name: string, observation: Observation): string {
    return this.saveJson(name, publicObservation(observation));
  }

  saveIntervention(req: InterventionRequest): string {
    return this.saveJson("intervention.json", {
      ...req,
      observationPreview: req.observationPreview ? "[redacted]" : undefined,
    });
  }

  saveResult(result: RunResult): string {
    return this.saveJson("result.json", result);
  }
}

export function newRunId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${stamp}`;
}
