# Bot Commands

After [linking your GitHub account](#linking-your-account), you can act on GitHub **as yourself** from Discord, Telegram and Feishu — comments are posted with your own OAuth token and GitHub enforces permission. If GitHub rejects an action (e.g. editing someone else's comment) the bot tells you so.

## Linking Your Account

You must link your GitHub account before using any command. The authorization lasts 10 hours; after that, run `/gh login` again:

| Platform | Command                           | Effect                                                           |
| -------- | --------------------------------- | ---------------------------------------------------------------- |
| Discord  | `/gh login`                       | Returns an ephemeral OAuth link to authorize your GitHub account |
| Discord  | `/gh logout`                      | Unlinks your GitHub account                                      |
| Telegram | `/gh login` (private chat only)   | Returns an OAuth link                                            |
| Telegram | `/gh logout` (reply to a message) | Unlinks your GitHub account                                      |

The link is stored server-side (KV) and mapped to your Discord/Telegram/Feishu user id in D1.

After authorizing on GitHub you see a confirmation page naming **both** accounts (your GitHub login and the chat account that requested the link); nothing is linked until you confirm. If you did not start the login yourself — e.g. someone forwarded you their link — just close the page. On Telegram and Feishu, `/gh login` is only answered in the private chat with the bot, so authorization links are never posted to a group.

Commands run once per platform event: a redelivered Telegram update, a retried Feishu event or a replayed Discord interaction does not repeat a comment, merge or close. A command that failed before reaching GitHub (for example a storage error) is given back to the platform and runs again on its redelivery; once a command may have reached GitHub it is never repeated — if the bot's reply then fails, check GitHub before sending the command again.

## Discord

Discord commands are **slash commands** and **message context-menu commands**, synced by the scheduled trigger (every 5 minutes): per-guild for instant availability (at most 30 Discord API calls per run, so a bot in many guilds catches up over several runs), and globally (~1h propagation). Both are registered again when the command definitions change, and the global set at least daily. All replies are ephemeral (only you see them).

### Comment on an issue / PR

Two equivalent ways:

- **Right-click a notification** (recommended): right-click a bot-issued issue / PR / comment notification → **Apps** → **GitHub: 添加评论 / 编辑评论 / 删除评论**. The target is auto-extracted from the notification embed; no link needed.
- **Slash command with a link**:

  ```
  /gh comment add  link:<issue or PR url>          e.g. https://github.com/owner/repo/issues/123
  /gh comment edit link:<comment url>              url must contain #issuecomment-<id>
  /gh comment del  link:<comment url>              url must contain #issuecomment-<id>
  ```

  For `edit` / `del`, copy the specific comment link on GitHub (comment ⋯ menu → **Copy link**). `add` / `edit` open a modal to enter/adjust the comment body (prefilled for edit, up to Discord's 4000-character limit; longer comments must be edited on GitHub so nothing is cut off). Saving an edit is refused when the comment changed on GitHub after the modal opened — reopen it to start from the current text. The body is posted as typed (indentation and line breaks kept). Only `https://github.com/...` links are accepted.

### Merge / close a PR

Notifications for open PRs on github.com include **Merge / Close** buttons (labels follow the group's message language; Gitea and other forges get no buttons, since the actions call the GitHub API):

- Clicking a button merges (squash) or closes the PR as your linked GitHub account; GitHub enforces permission.
- On success the buttons are removed from the notification and the result is shown in an ephemeral reply.

### Requirements

| Item         | How                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------- |
| Public key   | `DISCORD_PUBLIC_KEY` set + Interactions Endpoint URL configured                                    |
| Invite scope | Bot invited with `applications.commands` (see [Discord Bot Setup](./deployment#discord-bot-setup)) |
| OAuth        | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` and `BASE_URL` configured                              |
| User linked  | Each user runs `/gh login` first                                                                   |

## Telegram

Telegram `/gh` commands work by **replying to a notification message**:

- `/gh login` — link your GitHub account (private chat with the bot only; returns an OAuth link)
- `/gh logout` — unlink
- `/gh comment <text>` — reply to an issue/PR notification to comment as yourself
- `/gh merge` / `/gh close` — reply to a PR notification to merge/close it

The target issue/PR is parsed from the message you reply to (the notification embed links). In groups, the `/gh@YourBot …` form is accepted too (commands addressed to another bot are ignored). Comment text keeps its line breaks and indentation. Commands arrive via the Telegram webhook (`POST /telegram/webhook`), which always verifies the secret token — `TELEGRAM_WEBHOOK_SECRET`, or one derived from `TELEGRAM_TOKEN` when unset.

## Feishu

Feishu `/gh` commands are messages that start with `/gh` (after any @mention of the bot): `/gh login` (private chat only), `/gh logout`, `/gh comment <PR/Issue link> <text>`, `/gh merge <PR link>`, `/gh close <PR link>`; cards also carry **Merge** / **Close** buttons. Messages that merely mention `/gh` elsewhere are not commands. See [Feishu Bot Setup](./deployment#feishu-bot-setup) for the event subscription.
