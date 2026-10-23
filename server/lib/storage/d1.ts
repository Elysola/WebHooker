import { sharedFlight, type Flight } from "../lib/shared-flight";

/**
 * True when a D1Database binding looks like the real thing. Production D1
 * always exposes both `prepare` and `batch`; test harnesses range from
 * `DB: {}` (no methods at all) to minimal mocks that only implement
 * `prepare`→`bind`→{`run`,`all`} without `batch`. Using the presence of
 * `batch` as the probe means every existing test keeps its KV fallback path
 * while production eagerly routes through D1.
 */
export function canUseD1(db: D1Database | undefined | null): boolean {
  return typeof db?.prepare === "function" && typeof (db as D1Database).batch === "function";
}

/**
 * The D1 error says the table does not exist yet (migrations not applied).
 * Only this case may degrade a D1-backed store to KV: on any other failure
 * the two stores would each hold part of the state (a claim taken in D1 is
 * invisible in KV), so the error must propagate and the caller retry.
 */
export function isMissingTable(err: unknown): boolean {
  return /no such table/i.test(String(err));
}

/**
 * Set whenever state is written to KV instead of D1: by a D1-backed store
 * whose table was missing, and by every store of a deployment without D1
 * (which may get a D1 binding later). Until it expires — longer than any state
 * written that way lives, counted from the last such write — reads that find
 * nothing in D1 also look in KV, so that state is not forgotten. Its value is
 * its own expiry (ms), so a fresh enough marker is not rewritten.
 */
const KV_FALLBACK_MARKER = "storage:kv-fallback";
const KV_FALLBACK_TTL = 35 * 86400;
const MARKER_RECHECK_MS = 5 * 60_000;
const MARKER_ACTIVE_RECHECK_MS = 3600_000;
/** A fallback write refreshes the marker at most this often (per isolate). */
const MARKER_REFRESH_MS = 3600_000;
const fallbackMarkers = new WeakMap<
  KVNamespace,
  { active: boolean; until: number; writtenAt?: number }
>();
/** Marker reads in flight: concurrent checks share one KV read. */
const markerReads = new WeakMap<KVNamespace, Flight<boolean>>();

/** Marker refreshes in flight: concurrent fallbacks share one read and write. */
const markerWrites = new WeakMap<KVNamespace, Flight<void>>();
/** How long another request's marker read or write is waited for. */
const MARKER_FLIGHT_MS = 10_000;

export function noteKvFallback(kv: KVNamespace): Promise<void> {
  const cached = fallbackMarkers.get(kv);
  if (cached?.writtenAt != null && Date.now() - cached.writtenAt < MARKER_REFRESH_MS) {
    return Promise.resolve();
  }
  return sharedFlight(markerWrites, kv, () => writeFallbackMarker(kv), MARKER_FLIGHT_MS);
}

async function writeFallbackMarker(kv: KVNamespace): Promise<void> {
  const stored = Number(await kv.get(KV_FALLBACK_MARKER));
  // Rewritten at most about daily, whatever the number of isolates.
  if (!(stored - Date.now() > (KV_FALLBACK_TTL - 86400) * 1000)) {
    await kv.put(KV_FALLBACK_MARKER, String(Date.now() + KV_FALLBACK_TTL * 1000), {
      expirationTtl: KV_FALLBACK_TTL,
    });
  }
  // Remembered only once it is stored: a failed write is tried again by the
  // next fallback instead of being taken for done.
  fallbackMarkers.set(kv, {
    active: true,
    until: Date.now() + MARKER_ACTIVE_RECHECK_MS,
    writtenAt: Date.now(),
  });
}

export async function kvFallbackActive(kv: KVNamespace): Promise<boolean> {
  // "No marker" is remembered for a few minutes too: this check runs on
  // nearly every claim, and reading KV each time would spend the KV read
  // quota (Workers Free) on a marker that is almost always absent. The cost
  // is a short window after another isolate first sets it (accepted).
  // A seen marker is read again hourly: once it has expired, the KV
  // lookups it turns on stop too (a long-lived isolate would otherwise keep
  // reading KV for state long gone).
  const cached = fallbackMarkers.get(kv);
  if (cached && Date.now() < cached.until) return cached.active;
  return sharedFlight(
    markerReads,
    kv,
    async () => {
      const active = (await kv.get(KV_FALLBACK_MARKER)) != null;
      fallbackMarkers.set(kv, {
        active,
        until: Date.now() + (active ? MARKER_ACTIVE_RECHECK_MS : MARKER_RECHECK_MS),
        writtenAt: fallbackMarkers.get(kv)?.writtenAt,
      });
      return active;
    },
    MARKER_FLIGHT_MS,
  );
}
