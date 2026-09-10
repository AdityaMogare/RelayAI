export function rewriteBase(url: string, baseUrl?: string): string {
  if (!baseUrl) return url;
  try {
    const original = new URL(url);
    const base = new URL(baseUrl);
    original.protocol = base.protocol;
    original.host = base.host;
    return original.toString();
  } catch {
    return url;
  }
}
