import { describe, it, expect } from "bun:test";
import { formatEvent } from "../server/lib/formatters";
import { forgeInfo, MAX_COMMIT_SUBJECT } from "../server/lib/formatters/helpers";
import type { Route, WebhookEvent } from "../server/lib/types";

const route: Route = {
  id: "test",
  name: "Test",
  enabled: true,
  filters: [],
  targets: [{ channelId: "111" }],
};

function event(ev: string, payload: Record<string, unknown>): WebhookEvent {
  return { event: ev, payload };
}

const repo = { full_name: "acme/widget", html_url: "https://github.com/acme/widget" };
const sender = { login: "octocat" };

describe("message title spec", () => {
  it("push title starts with the repo", () => {
    const msg = formatEvent(
      route,
      event("push", {
        ref: "refs/heads/main",
        compare: "https://github.com/acme/widget/compare/abc...def",
        created: false,
        forced: false,
        commits: [{ id: "abcd1234ef", message: "fix stuff", added: [], removed: [], modified: [] }],
        repository: repo,
        sender,
      }),
    );
    expect(msg.title).toBe(
      "acme/widget: Pushed 1 commit to [`main`](https://github.com/acme/widget/tree/main)",
    );
    expect(msg.description).toBe(
      "[`abcd123`](https://github.com/acme/widget/commit/abcd1234ef) fix stuff",
    );
    expect(msg.fields).toEqual([
      {
        name: "Changes",
        value: "[View comparison](https://github.com/acme/widget/compare/abc...def):",
        inline: false,
      },
    ]);
  });

  it("adds a commit author link when it differs from the pusher", () => {
    const msg = formatEvent(
      route,
      event("push", {
        ref: "refs/heads/main",
        commits: [
          {
            id: "abcd1234ef",
            message: "fix stuff",
            author: { username: "commit-author" },
            added: [],
            removed: [],
            modified: [],
          },
        ],
        pusher: { name: "merge-bot" },
        repository: repo,
        sender,
      }),
    );

    expect(msg.description).toBe(
      "[`abcd123`](https://github.com/acme/widget/commit/abcd1234ef) fix stuff - [commit-author](https://github.com/commit-author)",
    );
  });

  it("does not add a commit author link when it matches the pusher", () => {
    const msg = formatEvent(
      route,
      event("push", {
        ref: "refs/heads/main",
        commits: [
          {
            id: "abcd1234ef",
            message: "fix stuff",
            author: { username: "octocat" },
            added: [],
            removed: [],
            modified: [],
          },
        ],
        pusher: { name: "OctoCat" },
        repository: repo,
        sender,
      }),
    );

    expect(msg.description).toBe(
      "[`abcd123`](https://github.com/acme/widget/commit/abcd1234ef) fix stuff",
    );
  });

  it("uses the author name when GitHub cannot resolve a bot username", () => {
    const msg = formatEvent(
      route,
      event("push", {
        ref: "refs/heads/main",
        commits: [
          {
            id: "abcd1234ef",
            message: "fix stuff",
            author: { name: "dependabot[bot]", username: "invalid-email-address" },
            added: [],
            removed: [],
            modified: [],
          },
        ],
        pusher: { name: "merge-bot" },
        repository: repo,
        sender,
      }),
    );

    expect(msg.description).toBe(
      "[`abcd123`](https://github.com/acme/widget/commit/abcd1234ef) fix stuff - dependabot[bot]",
    );
  });

  it("pull_request title is repo#number: title", () => {
    const msg = formatEvent(
      route,
      event("pull_request", {
        action: "opened",
        number: 7,
        pull_request: {
          title: "Add feature",
          number: 7,
          state: "open",
          merged: false,
          draft: false,
          html_url: "https://github.com/acme/widget/pull/7",
          body: null,
          user: sender,
          head: { ref: "feat", repo: { full_name: "acme/widget" } },
          base: { ref: "main" },
        },
        repository: repo,
        sender,
      }),
    );
    expect(msg.title).toBe("acme/widget#7: Add feature");
  });

  it("issue_comment title has no 'Comment on' prefix", () => {
    const msg = formatEvent(
      route,
      event("issue_comment", {
        action: "created",
        issue: {
          number: 3,
          title: "Bug report",
          html_url: "https://github.com/acme/widget/issues/3",
        },
        comment: {
          body: "thanks",
          html_url: "https://github.com/acme/widget/issues/3#issuecomment-1",
        },
        repository: repo,
        sender,
      }),
    );
    expect(msg.title).toBe("acme/widget#3: Bug report");
    expect(msg.title).not.toContain("Comment on");
  });

  it("workflow_run title is repo: name — conclusion", () => {
    const msg = formatEvent(
      route,
      event("workflow_run", {
        action: "completed",
        workflow_run: {
          name: "CI",
          conclusion: "success",
          html_url: "https://github.com/acme/widget/actions/runs/42",
          head_branch: "main",
          run_number: 42,
          jobs: [{ name: "build", conclusion: "success" }],
        },
        repository: repo,
        sender,
      }),
    );
    expect(msg.title).toBe(
      "acme/widget: [CI — success](https://github.com/acme/widget/actions/runs/42)",
    );
    expect(msg.fields![1].value).toBe("```diff\n+ build ✅ success\n```");
  });

  it("workflow_run distinguishes queued and running from pending", () => {
    const run = {
      name: "CI",
      conclusion: null as string | null,
      html_url: "https://github.com/acme/widget/actions/runs/42",
      head_branch: "main",
      run_number: 42,
    };
    const queued = formatEvent(
      route,
      event("workflow_run", {
        action: "requested",
        workflow_run: run,
        repository: repo,
        sender,
      }),
    );
    expect(queued.title).toBe(
      "acme/widget: [CI — queued](https://github.com/acme/widget/actions/runs/42)",
    );
    expect(queued.fields![0].value).toBe("⏳ queued");

    const running = formatEvent(
      route,
      event("workflow_run", {
        action: "in_progress",
        workflow_run: run,
        repository: repo,
        sender,
      }),
    );
    expect(running.title).toBe(
      "acme/widget: [CI — running](https://github.com/acme/widget/actions/runs/42)",
    );
    expect(running.fields![0].value).toBe("🔄 running");
  });

  it("workflow_run jobs render as a colored diff block with durations", () => {
    const msg = formatEvent(
      route,
      event("workflow_run", {
        action: "completed",
        workflow_run: {
          name: "CI",
          conclusion: "success",
          html_url: "https://github.com/acme/widget/actions/runs/42",
          run_number: 42,
          jobs: [
            {
              name: "build",
              status: "completed",
              conclusion: "success",
              started_at: "2024-01-01T00:00:00Z",
              completed_at: "2024-01-01T00:01:23Z",
            },
            { name: "deploy", status: "in_progress", conclusion: null },
            { name: "lint", status: "queued", conclusion: null },
            {
              name: "test",
              status: "completed",
              conclusion: "failure",
              started_at: "2024-01-01T00:00:00Z",
              completed_at: "2024-01-01T00:00:45Z",
            },
          ],
        },
        repository: repo,
        sender,
      }),
    );
    const jobField = msg.fields!.find((f) => f.name === "Job");
    expect(jobField!.value).toBe(
      [
        "```diff",
        "+ build ✅ success · 1m 23s",
        "  deploy 🔄 running",
        "  lint ⏳ queued",
        "- test ❌ failure · 0m 45s",
        "```",
      ].join("\n"),
    );
  });

  it("check_run uses status for queued and running", () => {
    const checkRun = {
      id: 42,
      name: "Lint",
      html_url: "https://github.com/acme/widget/runs/1",
      conclusion: null as string | null,
      status: "in_progress",
    };
    const msg = formatEvent(
      route,
      event("check_run", { check_run: checkRun, repository: repo, sender }),
    );
    expect(msg.title).toBe("acme/widget: Lint — running");
    expect(msg.fields![0].value).toBe("🔄 running");
    expect(msg.updateKey).toBe("check_run:acme/widget:42");
  });

  it("check_run omits updateKey without a run id", () => {
    const msg = formatEvent(
      route,
      event("check_run", {
        check_run: { name: "Lint", status: "completed", conclusion: "success" },
        repository: repo,
        sender,
      }),
    );
    expect(msg.updateKey).toBeUndefined();
  });

  it("check_run keys on name + head_sha for stable in-place edits", () => {
    const running = formatEvent(
      route,
      event("check_run", {
        check_run: {
          id: 42,
          name: "Cloudflare Pages",
          head_sha: "abc123def456",
          status: "in_progress",
          conclusion: null,
          check_suite: { id: 7 },
        },
        repository: repo,
        sender,
      }),
    );
    const failed = formatEvent(
      route,
      event("check_run", {
        check_run: {
          id: 43,
          name: "Cloudflare Pages",
          head_sha: "abc123def456",
          status: "completed",
          conclusion: "failure",
          check_suite: { id: 7 },
        },
        repository: repo,
        sender,
      }),
    );
    expect(running.updateKey).toBe("check_run:acme/widget:7:Cloudflare Pages:abc123def456");
    expect(failed.updateKey).toBe(running.updateKey);
    // A same-named check of another suite (workflow / app) has its own message.
    const other = formatEvent(
      route,
      event("check_run", {
        check_run: {
          id: 44,
          name: "Cloudflare Pages",
          head_sha: "abc123def456",
          status: "completed",
          conclusion: "success",
          check_suite: { id: 8 },
        },
        repository: repo,
        sender,
      }),
    );
    expect(other.updateKey).not.toBe(running.updateKey);
  });

  it("check_suite shows conclusion, service, branch and commit", () => {
    const suite = {
      html_url: "https://github.com/acme/widget/runs/2",
      conclusion: "success",
      status: "completed",
      app: { name: "Cloudflare Pages" },
      head_branch: "main",
      head_sha: "abc123def456",
    };
    const msg = formatEvent(
      route,
      event("check_suite", { check_suite: suite, repository: repo, sender }),
    );
    expect(msg.title).toBe("acme/widget: Check suite success");
    expect(msg.url).toBe("https://github.com/acme/widget/runs/2");
    expect(msg.fields![0].value).toBe("✅ success");
    expect(msg.fields![1].value).toBe("Cloudflare Pages");
    expect(msg.fields![2].value).toBe("[\`main\`](https://github.com/acme/widget/tree/main)");
    expect(msg.fields![3].value).toBe(
      "[\`abc123d\`](https://github.com/acme/widget/commit/abc123def456)",
    );
  });

  it("workflow_job shows job status, workflow, branch and commit", () => {
    const job = {
      html_url: "https://github.com/acme/widget/actions/runs/2/job/9",
      name: "test",
      status: "completed",
      conclusion: "failure",
      workflow_name: "CI",
      head_branch: "main",
      head_sha: "abc123def456",
    };
    const msg = formatEvent(
      route,
      event("workflow_job", { workflow_job: job, repository: repo, sender }),
    );
    expect(msg.title).toBe("acme/widget: Job test — failure");
    expect(msg.fields![0].value).toBe("❌ failure");
    expect(msg.fields![1].value).toBe("test");
    expect(msg.fields![2].value).toBe("CI");
    expect(msg.fields![3].value).toBe("[\`main\`](https://github.com/acme/widget/tree/main)");
    expect(msg.fields![4].value).toBe(
      "[\`abc123d\`](https://github.com/acme/widget/commit/abc123def456)",
    );
  });

  it("status shows context, state and commit", () => {
    const msg = formatEvent(
      route,
      event("status", {
        state: "pending",
        context: "continuous-integration/travis-ci",
        description: "The Travis CI build is in progress",
        target_url: "https://travis-ci.org/acme/widget/builds/1",
        sha: "abc123def456",
        repository: repo,
        sender,
      }),
    );
    expect(msg.title).toBe("acme/widget: continuous-integration/travis-ci — pending");
    expect(msg.fields![0].value).toBe("⏳ pending");
    expect(msg.fields![1].value).toBe("continuous-integration/travis-ci");
    expect(msg.fields![2].value).toBe(
      "[\`abc123d\`](https://github.com/acme/widget/commit/abc123def456)",
    );
    expect(msg.fields![3].value).toBe("The Travis CI build is in progress");
  });

  it("deployment shows environment, branch and commit", () => {
    const deployment = {
      environment: "production",
      ref: "refs/heads/main",
      sha: "abc123def456",
      description: "Deploy request from octocat",
      html_url: "https://github.com/acme/widget/deployments/1",
    };
    const msg = formatEvent(route, event("deployment", { deployment, repository: repo, sender }));
    expect(msg.title).toBe("acme/widget: Deployment to `production` — created");
    expect(msg.fields![0].value).toBe("🚀 created");
    expect(msg.fields![1].value).toBe("production");
    expect(msg.fields![2].value).toBe("[\`main\`](https://github.com/acme/widget/tree/main)");
    expect(msg.fields![3].value).toBe(
      "[\`abc123d\`](https://github.com/acme/widget/commit/abc123def456)",
    );
  });

  it("ping shows the webhook confirmation", () => {
    const msg = formatEvent(
      route,
      event("ping", { zen: "Keep it logically awesome.", hook_id: 1, repository: repo, sender }),
    );
    expect(msg.title).toBe("acme/widget: Webhook ping");
    expect(msg.fields![0].value).toBe("1");
  });

  it("unknown events fall back to repo: event: action", () => {
    const msg = formatEvent(
      route,
      event("custom_event", { action: "ran", repository: repo, sender }),
    );
    expect(msg.title).toBe("acme/widget: custom_event: ran");
  });
});

describe("group emoji toggle", () => {
  it("includes emoji by default", () => {
    const msg = formatEvent(
      route,
      event("repository", {
        action: "created",
        repository: { ...repo, visibility: "public", description: "a widget", fork: false },
        sender,
      }),
    );
    expect(msg.title).toBe("acme/widget: 📦 Repository Created");
    expect(msg.description).toContain("🔗");
  });

  it("strips emoji when showEmoji is false", () => {
    const msg = formatEvent(
      route,
      event("repository", {
        action: "created",
        repository: { ...repo, visibility: "public", description: "a widget", fork: false },
        sender,
      }),
      undefined,
      false,
    );
    expect(msg.title).toBe("acme/widget: Repository Created");
    expect(msg.title).not.toContain("📦");
    expect(msg.description).not.toContain("🔗");
  });

  it("push with deleted:true renders as a branch deletion", () => {
    const msg = formatEvent(
      route,
      event("push", {
        ref: "refs/heads/dependabot/npm_and_yarn/multi-e1b34b8be3",
        before: "abcd1234ef",
        after: "0000000000000000000000000000000000000000",
        created: false,
        forced: false,
        deleted: true,
        commits: [],
        repository: repo,
        sender,
      }),
    );
    expect(msg.title).toBe(
      "acme/widget: 🌿 Deleted branch dependabot/npm_and_yarn/multi-e1b34b8be3",
    );
    expect(msg.url).toBe(
      "https://github.com/acme/widget/tree/dependabot/npm_and_yarn/multi-e1b34b8be3",
    );
    expect(msg.description).toBeUndefined();
    expect(msg.fields).toBeUndefined();
  });

  it("push commit renders linked short hash with plain-text message", () => {
    const msg = formatEvent(
      route,
      event("push", {
        ref: "refs/heads/main",
        compare: "https://github.com/acme/widget/compare/abc...def",
        created: false,
        forced: false,
        commits: [{ id: "abcd1234ef", message: "fix stuff", added: [], removed: [], modified: [] }],
        repository: repo,
        sender,
      }),
    );
    expect(msg.description).toBe(
      "[`abcd123`](https://github.com/acme/widget/commit/abcd1234ef) fix stuff",
    );
  });

  it("strips emoji from push description when disabled", () => {
    const msg = formatEvent(
      route,
      event("push", {
        ref: "refs/heads/main",
        compare: "https://github.com/acme/widget/compare/abc...def",
        created: true,
        forced: true,
        commits: [{ id: "abcd1234ef", message: "fix stuff", added: [], removed: [], modified: [] }],
        repository: repo,
        sender,
      }),
      undefined,
      false,
    );
    expect(msg.description).not.toContain("⚠️");
    expect(msg.description).not.toContain("🆕");
  });

  it("strips emoji from workflow_run status when disabled", () => {
    const msg = formatEvent(
      route,
      event("workflow_run", {
        action: "completed",
        workflow_run: {
          name: "CI",
          conclusion: "failure",
          html_url: "https://github.com/acme/widget/actions/runs/42",
          head_branch: "main",
          run_number: 42,
          jobs: [{ name: "build", conclusion: "failure" }],
        },
        repository: repo,
        sender,
      }),
      undefined,
      false,
    );
    expect(msg.fields![0].value).toBe("failure");
    expect(msg.fields![1].value).toBe("```diff\n- build failure\n```");
  });
});

describe("limits and localization", () => {
  it("pull_request buttons use localized labels", () => {
    const msg = formatEvent(
      route,
      event("pull_request", {
        action: "opened",
        pull_request: {
          title: "Add feature",
          number: 7,
          state: "open",
          merged: false,
          html_url: "https://github.com/acme/widget/pull/7",
          head: { ref: "feat" },
          base: { ref: "main" },
        },
        repository: repo,
        sender,
      }),
    );
    expect(msg.actions?.map((a) => a.label)).toEqual(["Merge", "Close"]);
  });

  it("workflow_run job list is capped to the field value limit", () => {
    const jobs = Array.from({ length: 60 }, (_, i) => ({
      name: `job-${i}`,
      conclusion: "success",
    }));
    const msg = formatEvent(
      route,
      event("workflow_run", {
        action: "completed",
        workflow_run: { name: "CI", conclusion: "success", run_number: 1, jobs },
        repository: repo,
        sender,
      }),
    );
    const jobField = msg.fields!.find((f) => f.name === "Job");
    expect(jobField!.value!.length).toBeLessThanOrEqual(1024);
  });

  it("commit message is truncated at the subject limit", () => {
    const link = "[`abcd123`](https://github.com/acme/widget/commit/abcd1234ef)";
    const msg = formatEvent(
      route,
      event("push", {
        ref: "refs/heads/main",
        created: false,
        forced: false,
        commits: [
          { id: "abcd1234ef", message: "x".repeat(300), added: [], removed: [], modified: [] },
        ],
        repository: repo,
        sender,
      }),
    );
    expect(msg.description).toBe(`${link} ${"x".repeat(MAX_COMMIT_SUBJECT)}`);
  });

  it("tag push created renders as a tag creation", () => {
    const msg = formatEvent(
      route,
      event("push", {
        ref: "refs/tags/v1.0",
        created: true,
        forced: false,
        deleted: false,
        commits: [],
        repository: repo,
        sender,
      }),
    );
    expect(msg.title).toBe("acme/widget: 🏷️ Created tag v1.0");
    expect(msg.url).toBe("https://github.com/acme/widget/releases/tag/v1.0");
    expect(msg.color).toBe(4176208);
    expect(msg.description).toBeUndefined();
  });

  it("commit_comment without a commit id omits the sha", () => {
    const msg = formatEvent(
      route,
      event("commit_comment", {
        action: "created",
        comment: { body: "why?" },
        repository: repo,
        sender,
      }),
    );
    expect(msg.title).toBe("acme/widget: Comment on commit");
    expect(msg.fields).toBeUndefined();
  });

  it("sender profile link follows the forge when html_url is missing", () => {
    const msg = formatEvent(
      route,
      event("push", {
        ref: "refs/heads/main",
        created: false,
        forced: false,
        commits: [{ id: "abcd1234ef", message: "x", added: [], removed: [], modified: [] }],
        repository: { full_name: "org/repo", html_url: "https://git.example.com/org/repo" },
        sender: { login: "octo" },
      }),
    );
    expect(msg.author?.url).toBe("https://git.example.com/octo");
  });

  it("custom payload fields and values are capped", () => {
    const fields = Array.from({ length: 30 }, (_, i) => ({
      name: `f${i}`,
      value: "y".repeat(2000),
    }));
    const msg = formatEvent(
      route,
      event("custom", {
        title: "Deploy failed",
        repo: "acme/widget",
        color: "red",
        description: "x".repeat(5000),
        fields,
      }),
    );
    expect(msg.fields!.length).toBe(25);
    expect(msg.fields!.every((f) => f.value.length <= 1024)).toBe(true);
    expect(msg.description!.length).toBe(4096);
  });

  it("strips HTML tags from issue and PR bodies", () => {
    const issue = formatEvent(
      route,
      event("issues", {
        action: "opened",
        issue: {
          number: 3,
          title: "Bug",
          html_url: "https://github.com/acme/widget/issues/3",
          body: "Use <b>bold</b> and <code>code</code>",
        },
        repository: repo,
        sender,
      }),
    );
    expect(issue.description).toContain("Use bold and code");
    expect(issue.description).not.toContain("<b>");
    expect(issue.description).not.toContain("<code>");

    const pr = formatEvent(
      route,
      event("pull_request", {
        action: "opened",
        pull_request: {
          number: 7,
          title: "Add feature",
          state: "open",
          html_url: "https://github.com/acme/widget/pull/7",
          body: 'Fixes <a href="https://x.example">the bug</a>',
          head: { ref: "feat" },
          base: { ref: "main" },
        },
        repository: repo,
        sender,
      }),
    );
    expect(pr.description).toContain("Fixes the bug");
    expect(pr.description).not.toContain("<a ");
  });
});

describe("forge source branding", () => {
  const ghHost = { host: "github.com", type: "github" as const };

  it("labels github events with the configured host and the github favicon", () => {
    expect(
      forgeInfo(
        {
          event: "push",
          provider: "github",
          payload: { repository: { html_url: "https://github.com/org/repo" } },
        },
        [ghHost],
      ),
    ).toEqual({
      name: "github.com",
      url: "https://github.com",
      iconUrl: "https://github.com/fluidicon.png",
    });
  });

  it("labels github events without a repository (ping) via the github.com fallback", () => {
    expect(forgeInfo({ event: "ping", provider: "github", payload: {} }, [ghHost])).toEqual({
      name: "github.com",
      url: "https://github.com",
      iconUrl: "https://github.com/fluidicon.png",
    });
  });

  it("matches distinct gitea instances by their own host", () => {
    const sources = [
      { host: "git1.example.com", type: "gitea" as const },
      { host: "git2.example.com", type: "gitea" as const },
    ];
    expect(
      forgeInfo(
        {
          event: "push",
          provider: "gitea",
          payload: { repository: { html_url: "https://git1.example.com/org/a" } },
        },
        sources,
      ),
    ).toEqual({
      name: "git1.example.com",
      url: "https://git1.example.com",
      iconUrl: "https://git1.example.com/assets/img/favicon.png",
    });
    expect(
      forgeInfo(
        {
          event: "push",
          provider: "gitea",
          payload: { repository: { html_url: "https://git2.example.com/org/b" } },
        },
        sources,
      ),
    ).toEqual({
      name: "git2.example.com",
      url: "https://git2.example.com",
      iconUrl: "https://git2.example.com/assets/img/favicon.png",
    });
  });

  it("labels gitea events with the configured name when set, else the host", () => {
    const sources = [
      { host: "git1.example.com", type: "gitea" as const, name: "内网 Gitea" },
      { host: "git2.example.com", type: "gitea" as const },
    ];
    expect(
      forgeInfo(
        {
          event: "push",
          provider: "gitea",
          payload: { repository: { html_url: "https://git1.example.com/org/a" } },
        },
        sources,
      ),
    ).toEqual({
      name: "内网 Gitea",
      url: "https://git1.example.com",
      iconUrl: "https://git1.example.com/assets/img/favicon.png",
    });
    expect(
      forgeInfo(
        {
          event: "push",
          provider: "gitea",
          payload: { repository: { html_url: "https://git2.example.com/org/b" } },
        },
        sources,
      ),
    ).toEqual({
      name: "git2.example.com",
      url: "https://git2.example.com",
      iconUrl: "https://git2.example.com/assets/img/favicon.png",
    });
    expect(
      forgeInfo(
        {
          event: "push",
          provider: "gitea",
          payload: { repository: { html_url: "https://git1.example.com/org/a" } },
        },
        [{ host: "git1.example.com", type: "gitea", name: "  " }],
      ),
    ).toEqual({
      name: "git1.example.com",
      url: "https://git1.example.com",
      iconUrl: "https://git1.example.com/assets/img/favicon.png",
    });
  });

  it("matches hosts case-insensitively", () => {
    expect(
      forgeInfo(
        {
          event: "push",
          provider: "gitea",
          payload: { repository: { html_url: "https://GIT1.Example.COM/org/a" } },
        },
        [{ host: "Git1.Example.com", type: "gitea" }],
      ),
    ).toEqual({
      name: "Git1.Example.com",
      url: "https://git1.example.com",
      iconUrl: "https://git1.example.com/assets/img/favicon.png",
    });
  });

  it("returns no label when the gitea repo url is missing or unparseable", () => {
    expect(
      forgeInfo({ event: "push", provider: "gitea", payload: {} }, [
        { host: "git1.example.com", type: "gitea" },
      ]),
    ).toBeUndefined();
    expect(
      forgeInfo(
        { event: "push", provider: "gitea", payload: { repository: { html_url: "not-a-url" } } },
        [{ host: "git1.example.com", type: "gitea" }],
      ),
    ).toBeUndefined();
  });

  it("returns undefined when no source matches the provider or host", () => {
    expect(
      forgeInfo({ event: "custom", provider: "custom", payload: {} }, [ghHost]),
    ).toBeUndefined();
    expect(
      forgeInfo(
        {
          event: "push",
          provider: "gitea",
          payload: { repository: { html_url: "https://other.example.com/org/a" } },
        },
        [ghHost],
      ),
    ).toBeUndefined();
    expect(forgeInfo({ event: "push", provider: "github", payload: {} }, [])).toBeUndefined();
    expect(forgeInfo({ event: "push", provider: "github", payload: {} })).toBeUndefined();
  });
});
