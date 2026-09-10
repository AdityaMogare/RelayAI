import type { MoneyValue, OutputDef, OutputValue } from "../core/types.ts";

export function parseMoney(raw: string): MoneyValue | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const neg = /^\(.*\)$/.test(trimmed) || trimmed.trim().startsWith("-");
  const currencyMatch = trimmed.match(/\b([A-Z]{3})\b/);
  const currency = currencyMatch?.[1] ?? "USD";
  const nums = trimmed.replace(/[^0-9.]/g, "");
  if (!nums || nums === ".") return undefined;
  const [whole, frac = ""] = nums.split(".");
  if (!/^\d+$/.test(whole ?? "")) return undefined;
  const minor = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isFinite(minor)) return undefined;
  return { currency, minor: neg ? -minor : minor };
}

export type CoerceResult =
  | { ok: true; value: OutputValue }
  | { ok: false; expected: string; observed: string };

export function coerceOutput(def: OutputDef | undefined, raw: string): CoerceResult {
  if (!def) return { ok: true, value: raw };
  if (def.type === "money") {
    const parsed = parseMoney(raw);
    if (!parsed) {
      return {
        ok: false,
        expected: `${def.name}: money { currency, minor }`,
        observed: raw.trim() === "" ? "(empty)" : raw,
      };
    }
    return { ok: true, value: parsed };
  }
  return { ok: true, value: raw };
}
