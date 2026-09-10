import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Capability } from "../core/types.ts";
import { parseCapability } from "./schema.ts";

export interface ArtifactStore {
  save(artifact: Capability): Promise<string>;
  load(idOrPath: string): Promise<Capability>;
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
    const path = idOrPath.endsWith(".json") ? resolve(idOrPath) : this.pathFor(idOrPath);
    return parseCapability(JSON.parse(readFileSync(path, "utf8")));
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
    const item = this.items.get(idOrPath);
    if (!item) throw new Error(`Unknown capability ${idOrPath}`);
    return item;
  }

  async list(): Promise<Capability[]> {
    return [...this.items.values()];
  }
}
