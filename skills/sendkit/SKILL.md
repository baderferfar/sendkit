---
name: sendkit
description: Send Telegram messages from an agent using the SendKit MCP `telegram` tool, falling back to the `sendkit` CLI when no MCP server is connected. Use this skill whenever the user wants to send, deliver, notify, ping, or DM someone over Telegram, mentions SendKit or any part of its toolset (sendkit-core, sendkit CLI, sendkit-mcp local server, sendkit-remote server), wants to confirm or manually verify that a message actually arrived, or is deciding between the MCP and CLI paths — even if they never say "SendKit" or "MCP" out loud.
---

# SendKit

SendKit sends Telegram messages. It ships three surfaces over one shared
implementation, so they behave identically and differ only in how the bot token
reaches them:

| Surface | Installed as | Entry point | Where the bot token comes from |
| --- | --- | --- | --- |
| Local MCP server (stdio) | `@ferfarbader/sendkit-mcp` | `sendkit-mcp`, tool `telegram` | `TELEGRAM_TOKEN` env var |
| CLI | `@ferfarbader/sendkit` | `sendkit telegram <chatId> <message>` | `~/.config/sendkit/config.json`, written by `sendkit init` |
| Remote MCP server (HTTP) | hosted endpoint | `https://<host>/<botToken>/mcp`, tool `telegram` | the bot token in the URL, behind OAuth |

Every surface takes the same two inputs — `chatId` and `message`, both non-empty
strings — and returns the same result: `{ ok: true, chatId, messageId }`. The
`messageId` is Telegram's own receipt, so it is the one piece of evidence worth
carrying back to the user.

## Choose a path: MCP first, CLI as fallback

Prefer an MCP `telegram` tool when one is connected. It carries the token for
you, validates arguments against the schema before the call, and returns
`structuredContent` you can read directly — no shell quoting, no token ever
passing through a command line where it could land in shell history or a
transcript.

Fall back to the CLI when there is no MCP server available, when the user
explicitly asks for the CLI, or when you are debugging SendKit itself and want
to see the raw JSON response. The trade-off to keep in mind: the CLI reads the
token from a local config file, so it only works on a machine where
`sendkit init` has already run.

If both are available and the user has no preference, use the MCP tool and say
which path you took. Users configuring SendKit want to know whether their MCP
wiring is actually being exercised.

## Before sending: get the two inputs right

A Telegram message is an outward-facing, irreversible action — once it is
delivered you cannot unsend it for the recipient. So resolve both inputs
concretely first:

- **`chatId`** — a numeric string like `"123456789"` for a direct chat, or a
  negative one like `"-1001234567890"` for a group or channel. Never guess or
  invent a chat ID, and never reuse one from an unrelated example: a wrong ID
  either errors out or delivers someone's message to a stranger. If you don't
  have it, ask. If the user doesn't know theirs, have them message the bot and
  then read the ID from `https://api.telegram.org/bot<token>/getUpdates` (the
  `message.chat.id` field) — remind them that URL contains the token, so it
  shouldn't be pasted into a shared channel.
- **`message`** — the exact text to deliver. Send plain text; no surface sets
  `parse_mode`, so Markdown and HTML markup arrive as literal characters rather
  than formatting. Telegram caps a single message at 4096 characters; for
  anything longer, split it into several sends and number them so the recipient
  can follow the order.

When the user's request is ambiguous about *what* to say, draft the text and show
it to them before sending rather than sending an approximation. One call sends to
one chat, so fan-out to several recipients means one call per chat ID.

## Send via the MCP `telegram` tool

Call the `telegram` tool with `{ "chatId": "...", "message": "..." }`. Both the
local and remote servers register the tool under the same name with the same
schema, so the call looks identical either way.

On success it returns text like `Message sent to 123456789 with messageId 42`
plus structured `{ ok: true, chatId, messageId }`.

## Send via the CLI

```bash
# One-time per machine: store the bot token at ~/.config/sendkit/config.json (mode 0600)
sendkit init --telegram-bot-token <botToken>

# Send
sendkit telegram "123456789" "Deploy finished successfully."
```

The send command prints the JSON result on success —
`{"ok":true,"chatId":"123456789","messageId":42}` — and on failure prints the
error message to stderr and exits non-zero. Read the exit code, not just the
output: an error line without a JSON result means nothing was delivered.

Quote the message as a single argument. In PowerShell use double quotes and
escape any inner double quotes with a backtick; in bash prefer single quotes for
text containing `$` or backticks. An unquoted multi-word message becomes extra
positional arguments and the command fails instead of sending.

If the token was never configured, both `sendkit` commands fail with
`Telegram Bot token is required. Run \`sendkit init\`` — that is a setup gap, not
a Telegram problem, so route the user to `init` rather than retrying.

## Verify the send

`ok: true` with a `messageId` means Telegram accepted and delivered the message —
that is the strongest confirmation SendKit can give, and it is worth reporting
verbatim ("delivered to chat 123456789, message ID 42") so the user can match it
against what they see in their client.

When the user asks to verify manually, or when a send is important enough that
silent misdelivery would be costly, walk them through it:

1. Report the `chatId` and `messageId` you got back.
2. Ask them to open that chat in Telegram and confirm the text arrived intact —
   especially line breaks and any characters that could have been mangled by
   shell quoting.
3. If they see nothing, the usual cause is a `chatId` pointing at a different
   chat than they expect, or a second bot token being used. Re-check the ID via
   `getUpdates` before resending, since a blind retry just delivers to the wrong
   place twice.

Do not claim a message was delivered without a `messageId` in hand. A thrown
error, a non-zero exit, or a timeout all mean "unknown or failed" — say that
plainly, because a user who believes a notification went out and acts on it is
worse off than one who knows it didn't.

## Common failures

Errors surface as the `description` string straight from Telegram's API, so the
wording is Telegram's, not SendKit's:

| Error | Cause | Fix |
| --- | --- | --- |
| `Unauthorized` | Bad or revoked bot token | Re-run `sendkit init`, or fix `TELEGRAM_TOKEN` / the remote URL's token segment |
| `Bad Request: chat not found` | Wrong `chatId`, or the bot has never been contacted by that user | Confirm the ID via `getUpdates`; the user must message the bot first |
| `Forbidden: bot was blocked by the user` | Recipient blocked the bot | Nothing SendKit can fix — tell the user |
| `Bad Request: message text is empty` | Empty or whitespace-only `message` | Supply real text; empty strings are rejected before the call |
| `TELEGRAM_TOKEN environment variable is not set` | Local MCP server started without its token | Set the env var in the MCP server config and restart the client |
| `401 unauthorized` from the remote server | Missing or expired OAuth token | Re-authenticate the MCP client against the remote server |

Retrying an identical send after a *successful* call sends a second message —
Telegram has no deduplication here. Only retry after a confirmed failure.

## Setting up a surface that isn't wired yet

If neither path is available, set one up rather than reaching for the Telegram
API by hand — the point of SendKit is that the token lives in one place instead
of being pasted into ad-hoc `curl` calls.

Local MCP server, registered with the user's MCP client:

```json
{
  "mcpServers": {
    "sendkit": {
      "command": "npx",
      "args": ["-y", "@ferfarbader/sendkit-mcp"],
      "env": { "TELEGRAM_TOKEN": "<botToken>" }
    }
  }
}
```

The client must be restarted before the `telegram` tool appears; a missing tool
right after editing config usually just means the server hasn't been reloaded.

CLI:

```bash
npm install -g @ferfarbader/sendkit
sendkit init --telegram-bot-token <botToken>
```

Remote MCP server: point the client at `https://<host>/<botToken>/mcp`. It is an
OAuth-protected endpoint, so the client completes an authorization flow before
the first tool call — there is no way to bypass that with a raw token header.

Either way, the user supplies the bot token from
[@BotFather](https://t.me/BotFather); creating a bot is theirs to do, not
something to automate on their behalf.

## Handling the bot token

A Telegram bot token is a live credential: anyone holding it can send as that
bot and read everything the bot receives. So keep it out of anything that gets
copied around — don't echo it back in chat, don't paste it into a commit, and
prefer the MCP `env` block or `sendkit init` over inlining it in a command that
lands in shell history. `sendkit init` writes its config file `0600` for exactly
this reason. If a token has already leaked somewhere visible, say so and point
the user at BotFather's `/revoke` instead of quietly continuing to use it.
