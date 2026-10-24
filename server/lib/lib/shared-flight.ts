/**
 * In-flight work shared by concurrent callers in one isolate (one token
 * exchange, one marker read, one setup run instead of one each).
 *
 * A run is started by one request and awaited by others. In Workers the
 * starting request can end or be canceled before its I/O settles; its
 * promise then never settles and its cleanup never runs. So another request
 * waits for a run only until `maxWaitMs` after it started, and a run that
 * old is never joined: the first caller to find it stuck starts a
 * replacement and links it from the stuck run (`replacedBy`), so every other
 * waiter of that run follows the link — even once the replacement has
 * finished and left the map — and a stuck run is replaced once, not once per
 * waiter. Nothing waits forever on runs that cannot finish: a caller that
 * found `MAX_JOINS` runs stuck runs alone.
 */
export interface Flight<T> {
  promise: Promise<T>;
  startedAt: number;
  replacedBy?: Flight<T>;
}

export interface FlightMap<K, T> {
  get(key: K): Flight<T> | undefined;
  set(key: K, value: Flight<T>): unknown;
  delete(key: K): boolean;
}

const STALE = Symbol("stale");
/** Runs a caller waits on (and finds stuck) before it runs alone. */
const MAX_JOINS = 3;

export async function sharedFlight<K, T>(
  flights: FlightMap<K, T>,
  key: K,
  run: () => Promise<T>,
  maxWaitMs: number,
): Promise<T> {
  let current = flights.get(key);
  for (let joined = 1; current; joined++) {
    const left = current.startedAt + maxWaitMs - Date.now();
    if (left > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof STALE>((resolve) => {
        timer = setTimeout(() => resolve(STALE), left);
      });
      try {
        const result = await Promise.race([current.promise, timeout]);
        if (result !== STALE) return result as T;
      } finally {
        clearTimeout(timer);
      }
    }
    // `current` is stuck.
    if (joined >= MAX_JOINS) return run();
    if (current.replacedBy) {
      current = current.replacedBy;
      continue;
    }
    const flight = start(flights, key, run, current);
    current.replacedBy = flight;
    return flight.promise;
  }
  return start(flights, key, run).promise;
}

/** Start a run and publish it, unless another run took the key meanwhile. */
function start<K, T>(
  flights: FlightMap<K, T>,
  key: K,
  run: () => Promise<T>,
  replacing?: Flight<T>,
): Flight<T> {
  const flight: Flight<T> = { promise: run(), startedAt: Date.now() };
  const published = flights.get(key);
  if (!published || published === replacing) flights.set(key, flight);
  const done = (): void => {
    if (flights.get(key) === flight) flights.delete(key);
  };
  flight.promise.then(done, done);
  return flight;
}
