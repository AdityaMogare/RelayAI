import type { Frame, Locator as PlaywrightLocator, Page } from "playwright";
import type { Locator as LogicalLocator } from "../core/types.ts";

export async function locateInFrames(page: Page, locator: LogicalLocator) {
  for (const frame of page.frames()) {
    const found = await locateInFrame(frame, locator);
    if (found) return found;
  }
  return null;
}

async function locateInFrame(frame: Frame, locator: LogicalLocator) {
  try {
    if ((await frame.locator("frameset").count()) > 0) return null;
    const root = scopedRoot(frame, locator);
    if (locator.by === "cellInRow") {
      const handle = await cellInRow(root, locator);
      if (handle && (await handle.count()) > 0) return handle.first();
      return null;
    }
    const handle = buildLocator(root, locator);
    if ((await handle.count()) > 0) return handle.first();
  } catch {
    return null;
  }
  return null;
}

/** Rows that do not wrap nested tables — skips chrome `tr`s that contain the whole work grid. */
function leafRows(root: Frame | PlaywrightLocator): PlaywrightLocator {
  return root.locator("tr:not(:has(table))");
}

function scopedRoot(frame: Frame, locator: LogicalLocator): Frame | PlaywrightLocator {
  if (locator.scope?.by === "region") {
    return frame.getByRole("group", { name: locator.scope.heading, exact: true });
  }
  if (locator.scope?.by === "row") {
    let row = leafRows(frame);
    for (const text of locator.scope.hasText) {
      if (text) row = row.filter({ hasText: text });
    }
    return row;
  }
  return frame;
}

async function cellInRow(root: Frame | PlaywrightLocator, locator: LogicalLocator): Promise<PlaywrightLocator | null> {
  const matches = locator.row?.matches ?? (locator.scope?.by === "row" ? locator.scope.hasText[0] : undefined);
  const column = locator.cell ?? locator.name ?? "";
  if (!matches || !column) return null;
  const row = leafRows(root).filter({ hasText: matches });
  const named = row.getByRole("link", { name: column, exact: true }).or(row.getByRole("button", { name: column, exact: true }));
  if ((await named.count()) > 0) return named.first();
  const table = row.locator("xpath=ancestor::table[1]");
  const headers = (await table.locator("th").allInnerTexts()).map((h) => h.trim());
  const idx = headers.findIndex((h) => h.toLowerCase() === column.toLowerCase());
  if (idx >= 0) return row.locator("td").nth(idx);
  return row.getByRole("cell", { name: column, exact: true });
}

function buildLocator(root: Frame | PlaywrightLocator, locator: LogicalLocator) {
  switch (locator.by) {
    case "role":
      return root.getByRole((locator.role ?? "generic") as Parameters<Frame["getByRole"]>[0], {
        name: locator.name,
        exact: true,
      });
    case "label":
      return root.getByLabel(locator.name ?? "", { exact: false });
    case "text":
      return root.getByText(locator.text ?? "", { exact: false });
    case "css":
      return root.locator(locator.selector ?? "body");
    default:
      return root.locator("body");
  }
}

export function parseAriaRefs(snapshot: string): { ref: string; role: string; name: string }[] {
  const refs: { ref: string; role: string; name: string }[] = [];
  const line = /-\s+([a-zA-Z0-9_-]+)(?:\s+"([^"]*)")?(?:.*\[ref=([^\]]+)\])?/g;
  let match: RegExpExecArray | null;
  while ((match = line.exec(snapshot))) {
    const role = match[1] ?? "";
    const name = match[2] ?? "";
    const ref = match[3];
    if (ref && name) refs.push({ ref, role, name });
  }
  return refs;
}
