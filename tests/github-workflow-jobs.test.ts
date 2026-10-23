import { describe, it, expect, afterEach } from "bun:test";
import { getWorkflowRunJobs } from "../server/lib/github/workflow-jobs";

function bufToPem(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  const b64 = btoa(s);
  return `-----BEGIN PRIVATE KEY-----\n${b64.replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----`;
}

async function makeAppKeyPair(): Promise<{ appId: string; pem: string }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  return { appId: "12345", pem: bufToPem(pkcs8) };
}

const JOBS_URL = "https://api.github.com/repos/acme/widget/actions/runs/42/jobs";

describe("getWorkflowRunJobs", () => {
  const restoredFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = restoredFetch;
  });

  function mockFetch(
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  ): string[] {
    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      return Promise.resolve(handler(url, init));
    }) as typeof fetch;
    return urls;
  }

  it("mints an installation token then lists the jobs", async () => {
    const { appId, pem } = await makeAppKeyPair();
    const jobs = [{ name: "build", status: "completed", conclusion: "success" }];
    const urls = mockFetch((url) => {
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "ghs_test" }), { status: 201 });
      }
      return new Response(JSON.stringify({ jobs }), { status: 200 });
    });

    const result = await getWorkflowRunJobs(JOBS_URL, appId, pem, 555);
    expect(result).toEqual(jobs);
    expect(urls[0]).toContain("/app/installations/555/access_tokens");
    expect(urls[1]).toContain(JOBS_URL);
    expect(urls[1]).toContain("per_page=100");
  });

  it("falls back to an unauthenticated request without App credentials", async () => {
    const jobs = [{ name: "test", status: "in_progress" }];
    let sawAuth: string | undefined;
    mockFetch((_url, init) => {
      sawAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return new Response(JSON.stringify({ jobs }), { status: 200 });
    });

    const result = await getWorkflowRunJobs(JOBS_URL, undefined, undefined, undefined);
    expect(result).toEqual(jobs);
    expect(sawAuth).toBeUndefined();
  });

  it("returns undefined when jobs_url is missing", async () => {
    let called = false;
    mockFetch(() => {
      called = true;
      return new Response("{}", { status: 200 });
    });
    expect(await getWorkflowRunJobs(undefined, undefined, undefined, undefined)).toBeUndefined();
    expect(called).toBe(false);
  });

  it("returns undefined when the API responds with an error", async () => {
    mockFetch(() => new Response("{}", { status: 403 }));
    expect(await getWorkflowRunJobs(JOBS_URL, undefined, undefined, undefined)).toBeUndefined();
  });

  it("returns undefined for an empty jobs list", async () => {
    mockFetch(() => new Response(JSON.stringify({ jobs: [] }), { status: 200 }));
    expect(await getWorkflowRunJobs(JOBS_URL, undefined, undefined, undefined)).toBeUndefined();
  });

  it("returns undefined when the request throws", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("network"))) as typeof fetch;
    expect(await getWorkflowRunJobs(JOBS_URL, undefined, undefined, undefined)).toBeUndefined();
  });

  it("always sends a User-Agent header (GitHub rejects requests without one)", async () => {
    let sawUA: string | undefined;
    let tokenUA: string | undefined;
    const { appId, pem } = await makeAppKeyPair();
    mockFetch((url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (url.includes("/access_tokens")) tokenUA = headers["User-Agent"];
      else sawUA = headers["User-Agent"];
      return new Response(
        JSON.stringify(
          url.includes("/access_tokens") ? { token: "ghs_test" } : { jobs: [{ name: "build" }] },
        ),
        { status: 200 },
      );
    });

    expect(await getWorkflowRunJobs(JOBS_URL, appId, pem, 5551)).toBeDefined();
    expect(tokenUA).toBeTruthy();
    expect(sawUA).toBeTruthy();
  });
});
