import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { redactDeep } from "../policy/redact.ts";
import type { EvidenceEvent, InterventionRequest, RunResult } from "../core/types.ts";

export class EvidenceStore {
  readonly dir: string;

  constructor(runId: string, root = resolve(process.cwd(), "evidence")) {
    this.dir = join(root, runId);
    mkdirSync(this.dir, { recursive: true });
  }

  event(kind: string, data: Record<string, unknown>): void {
    const event: EvidenceEvent = {
      at: new Date().toISOString(),
      runId: this.dir.split("/").pop() ?? "run",
      kind,
      data: redactDeep(data),
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
    writeFileSync(path, `${JSON.stringify(redactDeep(value), null, 2)}\n`, "utf8");
    return path;
  }

  saveIntervention(req: InterventionRequest): string {
    return this.saveJson("intervention.json", req);
  }

  saveResult(result: RunResult): string {
    return this.saveJson("result.json", result);
  }
}

export function newRunId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${stamp}`;
}
