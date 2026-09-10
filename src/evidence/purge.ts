import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_TTL_DAYS, loadRuntime } from "../policy/runtime.ts";

export type PurgeResult = {
  ttlDays: number;
  deleted: string[];
  kept: string[];
};

const KEEP = new Set(["README.md"]);

/**
 * Evidence TTL is 14 days. Screenshots of member records must not live forever
 * in a git repo. `npm run evidence:purge` deletes expired run directories and
 * any remaining PNGs older than the TTL.
 */
export function purgeEvidence(root = resolve(process.cwd(), "evidence"), now = Date.now()): PurgeResult {
  const ttlDays = loadRuntime().retention.ttlDays ?? DEFAULT_TTL_DAYS;
  const cutoff = now - ttlDays * 24 * 3600_000;
  const deleted: string[] = [];
  const kept: string[] = [];
  if (!existsSync(root)) return { ttlDays, deleted, kept };

  for (const name of readdirSync(root)) {
    if (KEEP.has(name)) {
      kept.push(name);
      continue;
    }
    const full = join(root, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (st.mtimeMs < cutoff) {
        rmSync(full, { recursive: true, force: true });
        deleted.push(name);
      } else {
        deleted.push(...purgePngs(full, cutoff));
        kept.push(name);
      }
    } else if (full.endsWith(".png") && st.mtimeMs < cutoff) {
      rmSync(full, { force: true });
      deleted.push(name);
    } else {
      kept.push(name);
    }
  }
  return { ttlDays, deleted, kept };
}

function purgePngs(dir: string, cutoff: number): string[] {
  const gone: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) gone.push(...purgePngs(full, cutoff));
    else if (name.endsWith(".png") && st.mtimeMs < cutoff) {
      rmSync(full, { force: true });
      gone.push(join(dir, name));
    }
  }
  return gone;
}
