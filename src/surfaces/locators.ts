import type { Frame, Page } from "playwright";
import type { Locator as LogicalLocator } from "../core/types.ts";

export async function locateInFrames(page: Page, locator: LogicalLocator) {
  for (const frame of page.frames()) {
    const found = await locateInFrame(frame, locator);
    if (found) return found;
  }
  return null;
}

async function locateInFrame(frame: Frame, locator: LogicalLocator) {
  const handle = buildLocator(frame, locator);
  try {
    if ((await handle.count()) > 0) return handle.first();
  } catch {
    return null;
  }
  return null;
}

function buildLocator(frame: Frame, locator: LogicalLocator) {
  switch (locator.by) {
    case "role":
      return frame.getByRole((locator.role ?? "generic") as Parameters<Frame["getByRole"]>[0], {
        name: locator.name,
        exact: true,
      });
    case "label":
      return frame.getByLabel(locator.name ?? "", { exact: false });
    case "text":
      return frame.getByText(locator.text ?? "", { exact: false });
    case "css":
      return frame.locator(locator.selector ?? "body");
    default:
      return frame.locator("body");
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
