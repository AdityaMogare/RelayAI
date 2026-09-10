export type RouteRule = {
  method: string;
  path: string;
};

export function normalizePath(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** `*` = one segment, `**` = zero or more segments. */
export function matchPath(pattern: string, pathname: string): boolean {
  return matchSegs(
    splitPath(normalizePath(pattern)),
    splitPath(normalizePath(pathname)),
  );
}

export function matchMethod(ruleMethod: string, requestMethod: string): boolean {
  if (ruleMethod === "*" || ruleMethod === "ANY") return true;
  return ruleMethod.toUpperCase() === requestMethod.toUpperCase();
}

export function matchRoute(rule: RouteRule, method: string, pathname: string): boolean {
  return matchMethod(rule.method, method) && matchPath(rule.path, pathname);
}

function splitPath(path: string): string[] {
  if (path === "/") return [];
  return path.split("/").filter(Boolean);
}

function matchSegs(pat: string[], segs: string[]): boolean {
  let i = 0;
  let j = 0;
  while (i < pat.length && j < segs.length) {
    const token = pat[i]!;
    if (token === "**") {
      if (i === pat.length - 1) return true;
      for (let k = j; k <= segs.length; k += 1) {
        if (matchSegs(pat.slice(i + 1), segs.slice(k))) return true;
      }
      return false;
    }
    if (token === "*" || token === segs[j]) {
      i += 1;
      j += 1;
      continue;
    }
    return false;
  }
  while (i < pat.length && pat[i] === "**") i += 1;
  return i === pat.length && j === segs.length;
}
