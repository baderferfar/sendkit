---
name: sendkit
description: Send Telegram messages from agents using SendKit, either through the SendKit MCP `telegram` tool or the `sendkit` CLI as a fallback. Use this skill whenever the user wants to send, deliver, or push a Telegram message or notification from an agent, mentions SendKit or the SendKit toolset in any form (`@ferfarbader/sendkit`, `sendkit-core`, `sendkit-mcp`, `sendkit-local`, `sendkit-remote`), wants to interact with, wire up, or manually verify SendKit end to end, needs to pick between the MCP and CLI workflows, or is debugging a failed Telegram send (bad chat ID, missing bot token, 401/403 from Telegram). Applies even when the user never says "SendKit" — "text me when the build finishes", "ping my Telegram group with the results", or "notify me on Telegram" are all this skill.
---

# SendKit

SendKit sends Telegram messages. It ships one capability, deliberately: `sendTelegramMessage` in
`@ferfarbader/sendkit-core`, exposed through three surfaces that all wrap that same function.

Everything below reflects the code in this repo — verify against the source if something looks off,
since the surfaces are thin enough that reading them is faster than guessing.

| Surface | Package | Entry | Token comes from |
|---|---|---|---|
| Local MCP (stdio) | `@ferfarbader/sendkit-mcp` | `sendkit-mcp` | `TELEGRAM_TOKEN` env var |
| Remote MCP (HTTP) | `apps/remote-mcp` | `POST /:botToken/mcp` | URL path segment + Clerk OAuth |
| CLI | `@ferfarbader/sendkit` | `sendkit` | `~/.config/sendkit/config.json` |

## Choosing MCP or CLI

**Reach for the MCP tool first.** If a `telegram` tool is in your available tools, use it. It's one
call, it returns structured output you can branch on, and it keeps the bot token out of your shell
history and out of your context entirely — the server injects it, so you never handle the secret.

**Fall back to the CLI when** no `telegram` MCP tool is connected, the MCP server is erroring and you
need to isolate whether the fault is in transport or in the Telegram call itself, or you're inside a
shell script or CI step where adding an MCP server isn't worth it.

Don't set up an MCP server mid-task just to send one message — if the CLI is already configured, use
it. Conversely, don't shell out repeatedly if the MCP tool is right there.

## Sending via the MCP tool

The tool is named `telegram` on both the local (`sendkit-local`) and remote (`sendkit-remote`)
servers. Its input schema is exactly two required fields:

```json
{ "chatId": "123456789", "message": "Build passed on main." }
```

- `chatId` — string, non-empty. Numeric IDs, negative group IDs (`"-1001234567890"`), and `@channel`
  handles all go here as strings. Passing a number fails schema validation.
- `message` — string, non-empty. Plain text only; see [Message content](#message-content).

Never pass a `botToken` in the tool input — it isn't in the schema, and the server supplies it. If
you find yourself wanting to, you've got the wrong surface; use the CLI.

Structured output on success:

```json
{ "ok": true, "chatId": "123456789", "messageId": 42 }
```

Report the `messageId` back when the user asked for confirmation of delivery — it's the only proof
the message actually landed, and it's what they'd use to find the message later.

### Wiring up the local MCP server

The local server talks stdio and reads the bot token from `TELEGRAM_TOKEN` at call time:

```json
{
  "mcpServers": {
    "sendkit": {
      "command": "sendkit-mcp",
      "env": { "TELEGRAM_TOKEN": "123456:ABC-your-bot-token" }
    }
  }
}
```

**Watch the env var name.** The server reads `TELEGRAM_TOKEN`, but this repo's `.env.example`
defines `TELEGRAM_BOT_TOKEN`. Copying `.env.example` and expecting the MCP server to pick it up
produces `TELEGRAM_TOKEN environment variable is not set`. When that error appears, check the name
before checking the value.

For local development against the workspace source, run `bun run dev:local-mcp` instead of the
published binary.

### Wiring up the remote MCP server

The remote server is Clerk-authenticated Streamable HTTP. The bot token is a path segment, so each
bot gets its own endpoint URL:

```
POST https://<host>/<botToken>/mcp
Authorization: Bearer <clerk-oauth-token>
```

Unauthenticated requests get a `401` plus a `WWW-Authenticate` header pointing at the protected
resource metadata, which is how a compliant MCP client discovers the OAuth flow on its own. That
discovery route is spelled `/.well-known/oauth-protected-ressource/:botToken/mcp` — note the
double-`s` `ressource`, which deviates from the spec's `oauth-protected-resource`. If a client
can't discover auth, this spelling is the first thing to check.

It needs `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` set or it refuses to boot. Run it with
`bun run dev:remote-mcp`.

## Sending via the CLI

Two commands. Configure once, then send.

```bash
# One-time: writes ~/.config/sendkit/config.json with mode 0600
sendkit init --telegram-bot-token "123456:ABC-your-bot-token"

# Send. chatId first, then the message as a single argument.
sendkit telegram "123456789" "Build passed on main."
```

On success it prints one line of JSON to stdout — `{"ok":true,"chatId":"123456789","messageId":42}` —
so pipe it to `jq` when scripting rather than parsing the text.

Two things that trip people up:

- **The CLI ignores environment variables.** It reads only the config file. `TELEGRAM_TOKEN` and
  `TELEGRAM_BOT_TOKEN` do nothing here. If you see `Telegram Bot token is required. Run
  \`sendkit init\``, the fix is `sendkit init`, not exporting a variable.
- **Quote the message.** Without quotes the shell splits it into extra arguments and Commander
  rejects the call. On PowerShell, prefer single quotes when the text contains `$`.

For workspace development, `bun run dev:cli -- telegram "<chatId>" "<message>"` runs the same code
from source.

## Message content

`sendTelegramMessage` posts `{ chat_id, text }` to Telegram's `sendMessage` — nothing else. There is
no `parse_mode`, so **Markdown and HTML are not rendered**. `*bold*` arrives as literal asterisks.

Write for plain text: line breaks and emoji work, so lead with the outcome and keep it short. Don't
build formatted reports here — if the user wants rich output, send a short notification and put the
detail somewhere that renders it.

Telegram caps a single message at 4096 characters and rejects longer ones, and SendKit doesn't split
or truncate. Trim before sending, or send a summary plus a link.

## Manual verification

When the user asks you to verify SendKit works, prove the full path rather than reading code. Send a
real message to a chat the user controls and confirm the `messageId` came back. A send that returns
no `messageId` did not happen.

Ask for the chat ID if you don't have one — don't guess, and don't reuse a chat ID from an unrelated
part of the conversation. Messaging the wrong chat is visible to real people and can't be undone by
you.

To get a chat ID: message the bot from the target chat, then open
`https://api.telegram.org/bot<token>/getUpdates` and read `result[].message.chat.id`.

Checklist for a full manual pass:

1. `sendkit init --telegram-bot-token "<token>"`, then `sendkit telegram "<chatId>" "sendkit cli check"` — proves core + Telegram credentials.
2. Start the local MCP server with `TELEGRAM_TOKEN` set, call the `telegram` tool with the same `chatId` — proves the MCP surface.
3. Confirm both messages arrived in the chat and both returned distinct `messageId`s.

If step 1 works and step 2 doesn't, the fault is in MCP wiring or the env var name, not in the
Telegram credentials. That split is the main reason to keep the CLI around.

## Troubleshooting

Errors surface Telegram's own `description` field, so read the message rather than pattern-matching
on status codes.

| Symptom | Cause | Fix |
|---|---|---|
| `TELEGRAM_TOKEN environment variable is not set` | Local MCP has no token, or it's set as `TELEGRAM_BOT_TOKEN` | Set `TELEGRAM_TOKEN` in the server's `env` block |
| `Telegram Bot token is required. Run \`sendkit init\`` | No CLI config file, or it has no token | Run `sendkit init --telegram-bot-token ...` |
| `Unauthorized` / 401 from Telegram | Bot token is wrong or revoked | Re-issue via BotFather, re-run `init` |
| `chat not found` | Wrong `chatId`, or the bot was never added to that chat | Verify with `getUpdates`; add the bot to the group |
| `bot was blocked by the user` | Recipient blocked the bot | Nothing to fix in code — tell the user |
| Zod error on `chatId` or `message` | Passed a number, or an empty string | Both must be non-empty strings |
| `401 {"error":"unauthorized"}` from remote MCP | Missing or invalid Clerk Bearer token | Complete the OAuth flow; check the `ressource` spelling in the discovery URL |

## Handling the bot token

A Telegram bot token is a full credential: anyone holding it can read and send as the bot. Keep it
out of chat, out of committed files, and out of anything you echo back to the user.

Prefer the MCP surfaces, where the server injects the token and you never see it. When you must use
the CLI, pass the token only inside the `sendkit init` call — it lands in a `0600` config file and
subsequent sends don't restate it. If the user pastes a token into the conversation, use it but don't
repeat it in your replies, and mention that it's now in their history and worth rotating.
