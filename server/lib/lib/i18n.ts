import { en } from "./locales/en";
import { zh } from "./locales/zh";
import { sharedFlight, type Flight } from "./shared-flight";

type NestedStrings = { [key: string]: string | NestedStrings };
export type Translations = NestedStrings;

function getByPath(obj: Record<string, unknown>, path: string): string | undefined {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    return key in params ? String(params[key]) : `{${key}}`;
  });
}

const cache = new Map<string, Translations>();

/** Languages found without an override, until when (a read failure is not one). */
const missing = new Map<string, number>();
const MISSING_RECHECK_MS = 5 * 60_000;
const MAX_MISSING = 100;
/** Override reads in flight: concurrent asks for one language share a KV read. */
const loading = new Map<string, Flight<Translations>>();

export async function loadTranslations(
  lang: string,
  kv?: { get<T>(key: string, type: "json"): Promise<T | null> },
): Promise<Translations> {
  if (lang === "en") return en;
  if (lang === "zh") return zh;

  const cached = cache.get(lang);
  if (cached) return cached;
  // A language with no override is not looked up again for a while: every
  // dispatch asks for each group's language, and each ask is a KV read.
  if ((missing.get(lang) ?? 0) > Date.now()) return en;

  if (!kv) return en;

  return sharedFlight(loading, lang, () => readOverride(lang, kv), 10_000);
}

async function readOverride(
  lang: string,
  kv: { get<T>(key: string, type: "json"): Promise<T | null> },
): Promise<Translations> {
  try {
    const stored = await kv.get<Partial<Translations>>(`i18n:${lang}`, "json");
    if (stored) {
      const merged = { ...en, ...stored } as Translations;
      cache.set(lang, merged);
      return merged;
    }
    if (missing.size >= MAX_MISSING) missing.clear();
    missing.set(lang, Date.now() + MISSING_RECHECK_MS);
  } catch {
    // KV read failed, fall back to EN
  }

  return en;
}

export function t(
  key: string,
  params?: Record<string, string | number>,
  lang?: string | null,
  translations?: Translations,
): string {
  const dict = translations ?? en;
  const raw =
    getByPath(dict as Record<string, unknown>, key) ??
    getByPath(en as Record<string, unknown>, key) ??
    key;
  return params ? interpolate(raw, params) : raw;
}
