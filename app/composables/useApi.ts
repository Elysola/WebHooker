/**
 * Shared "session expired" flag: any 401 from the admin API flips it and the
 * console swaps to the login card. One source of truth for every composable.
 */
export function useAuthState() {
  const needLogin = useState<boolean>("wh-need-login", () => false);
  return { needLogin };
}

/**
 * JSON fetch for same-origin admin API calls: sends credentials, treats 401
 * as "not logged in" (flips the shared flag and throws), and surfaces the
 * server's `{ error }` message on failure.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    // Live data, never from the browser cache. This also keeps requests out of
    // its per-URL cache lock: otherwise one request that never answers makes
    // every later request for the same URL wait up to 20 s behind it.
    cache: "no-store",
    ...init,
    // JSON in/out: h3's readBody only parses JSON bodies when the request
    // declares application/json, and the browser defaults string bodies to
    // text/plain — without this header every PUT/POST would arrive as a
    // raw string and fail validation.
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) {
    useAuthState().needLogin.value = true;
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}
