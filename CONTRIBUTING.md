# Contributing to WebHooker

Thanks for your interest in contributing! WebHooker is a Nuxt 4 (Nitro) app that runs as a
Cloudflare Worker, receiving GitHub/Gitea webhooks and dispatching them to Discord and Telegram.

## Development Setup

[Bun](https://bun.sh) is the only supported package manager — never use `npm`/`npx`.

```bash
git clone https://github.com/Elysola/WebHooker.git
cd WebHooker
bun install
cp .env.example .dev.vars   # Fill in secrets for local dev (wrangler reads this)
bun run dev                 # Start Nuxt dev server (HMR + Nitro)
```

## Scripts

| Command                | Description                          |
| ---------------------- | ------------------------------------ |
| `bun run dev`          | Start Nuxt dev server                |
| `bun run build`        | Production build (cloudflare preset) |
| `bunx wrangler dev`    | Preview a built worker (Miniflare)   |
| `bun run typecheck`    | TypeScript type checking             |
| `bun run lint`         | ESLint (TypeScript)                  |
| `bun run lint:md`      | Markdownlint                         |
| `bun test`             | Run the unit-test suite              |
| `bun run format`       | Format all files with Prettier       |
| `bun run format:check` | Check Prettier formatting            |
| `bun run docs:dev`     | Start the VitePress docs dev server  |
| `bun run db:migrate`   | Apply D1 migrations locally          |

## Code Style

- TypeScript in strict mode
- Double quotes, semicolons required, trailing commas, 100-char print width (Prettier)
- ESLint with `@typescript-eslint` recommended rules; Markdownlint for Markdown
- User-facing strings are bilingual (en + zh) in `app/composables/useI18n.ts`

## Testing

```bash
bun test
```

The suite includes per-module unit tests, provider fixtures (`tests/fixtures/`), formatter
snapshots (`tests/__snapshots__/`), and platform contract tests. CI runs
`bun install --frozen-lockfile`, `bun test`, and `bun run lint`.

## Commit Guidelines

- All commits must be GPG-signed
- Write concise, accurate messages in English using conventional-commit style
  (e.g. `feat(filters): ...`)
- Keep changes focused and atomic

## Documentation

Every functional change must keep its docs in sync: `AGENTS.md`, `README.md` / `README.zh.md`,
the VitePress docs (`docs/` and `docs/zh/` mirrors), and `config.example.yaml` / `.env.example`.
Code and docs must not drift.

## Pull Requests

- Run `bun run typecheck && bun run lint && bun test` before submitting
- Include type annotations for all function returns
- Update documentation for any feature or behavior change

For the full guide — including the project structure and how to add a new event formatter — see
[`docs/contributing.md`](docs/contributing.md).
