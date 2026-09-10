import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CapabilityNotFoundError } from "../core/errors.ts";
import type { Capability } from "../core/types.ts";
import { hashCapability, sha256Utf8 } from "./hash.ts";
import { parseCapability } from "./schema.ts";

export type LoadedCapability = {
  capability: Capability;
  path: string;
  contentHash: string;
};

/** Load `capabilities/<id>.json`. The JSON file is the source of truth — no in-memory goldens. */
export function readCapabilityFile(idOrPath: string, dir = resolve(process.cwd(), "capabilities")): LoadedCapability {
  const path = idOrPath.endsWith(".json") ? resolve(idOrPath) : join(dir, `${idOrPath}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new CapabilityNotFoundError(idOrPath, path, err);
  }
  return {
    capability: parseCapability(JSON.parse(raw)),
    path,
    contentHash: sha256Utf8(raw),
  };
}

export interface ArtifactStore {
  save(artifact: Capability): Promise<string>;
  load(idOrPath: string): Promise<Capability>;
  loadWithHash(idOrPath: string): Promise<LoadedCapability>;
  list(): Promise<Capability[]>;
}

export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly dir = resolve(process.cwd(), "capabilities")) {
    mkdirSync(this.dir, { recursive: true });
  }

  pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async save(artifact: Capability): Promise<string> {
    const parsed = parseCapability(artifact);
    const path = this.pathFor(parsed.id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return path;
  }

  async load(idOrPath: string): Promise<Capability> {
    return (await this.loadWithHash(idOrPath)).capability;
  }

  async loadWithHash(idOrPath: string): Promise<LoadedCapability> {
    return readCapabilityFile(idOrPath, this.dir);
  }

  async list(): Promise<Capability[]> {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => parseCapability(JSON.parse(readFileSync(join(this.dir, f), "utf8"))));
  }
}

export class MemoryArtifactStore implements ArtifactStore {
  private readonly items = new Map<string, Capability>();

  async save(artifact: Capability): Promise<string> {
    const parsed = parseCapability(artifact);
    this.items.set(parsed.id, parsed);
    return parsed.id;
  }

  async load(idOrPath: string): Promise<Capability> {
    return (await this.loadWithHash(idOrPath)).capability;
  }

  async loadWithHash(idOrPath: string): Promise<LoadedCapability> {
    const item = this.items.get(idOrPath);
    if (!item) throw new CapabilityNotFoundError(idOrPath, idOrPath);
    return { capability: item, path: idOrPath, contentHash: hashCapability(item) };
  }

  async list(): Promise<Capability[]> {
    return [...this.items.values()];
  }
}
