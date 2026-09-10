import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Capability } from "../core/types.ts";

export function sha256Utf8(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Hash the on-disk bytes so discover and replay can prove they used the same file. */
export function hashCapabilityFile(path: string): string {
  return sha256Utf8(readFileSync(path));
}

export function hashCapability(capability: Capability): string {
  return sha256Utf8(`${JSON.stringify(capability, null, 2)}\n`);
}
