# OptBot

**OptBot is an extension of [Bots Sidebar](https://github.com/tobi/bb-bots-sidebar)
by Tobias Lütke.** It keeps the Bots Sidebar experience (named bots, avatars,
sections, project roles, conversation trees, `@` mentions and bot-to-bot
messages) and replaces how a bot remembers with
[OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
(now UniiChat), Victor Taelin's design for one endless chat whose history is its memory.

OptBot is a separate BB plugin (ID `optbot`). It does not read, change or migrate
an installed Bots Sidebar's bots or data; both can be installed side by side.

## What changes compared to Bots Sidebar

| | Bots Sidebar | OptBot |
|---|---|---|
| Memory | A 3,000-character MEMORY.md the agent rewrites | Every message kept, compressed into a summary tree |
| Each turn | Resumes the provider's growing session | Starts fresh from a bounded view of the whole history |
| Old details | Lost when memory is condensed | Recovered by zooming down to the original message |
| Models | Native BB providers | Native BB providers, switchable mid-conversation |

## Install

```sh
bb plugin install https://github.com/KarthikRaju391/bb-plugin-optbot.git
```

Then choose **OptBot** in **Settings → Sidebar**.

### Set up the summarizer

Summaries are written through an existing Codex, Claude Code or Pi login on one
of your BB machines (that CLI's own login, not BB's Account Pooler). No API key is needed. If summaries keep failing (for example a
usage limit), a waiting turn ends after a minute with the summarizer's error
instead of hanging; your message stays in the history.

```sh
bb plugin config optbot set compactorHost <machine-id>        # a machine signed in to Codex
bb plugin config optbot set compactorModel bb/codex/gpt-6-luna # a small model is enough
bb optbot model check                                          # runs one test summary
```

`compactorModel` accepts `bb/codex[/<model>]`, `bb/claude-code[/<model>]` or
`bb/pi[/<provider>/<model>]` (for example `bb/pi/openai-codex/gpt-6-luna`). An API summarizer is also supported: set `compactorModel` to
an `openai/<model>` or `anthropic/<model>` ID and `compactorApiKey` (stored as a
secret).

### Summarize through Account Pooler (optional, unsupported)

Conversations already use Account Pooler when they run on Codex or Claude Code.
Summaries can use it too, so they switch accounts at a usage limit instead of
stopping on one CLI login:

```sh
bb plugin config optbot set compactorAccountPooler true
bb plugin config optbot set compactorModel bb/claude-code/claude-haiku-5-5
bb optbot model check
```

With `bb/claude-code/<model>`, the summary runs in the Claude Code CLI on the
compactor machine, pointed at Account Pooler the way BB points its Claude Code
threads; newer models such as Claude Haiku 5.5 are served only to Claude Code.
`pool/claude/<model>` (for example `pool/claude/claude-haiku-4-5`) and
`pool/codex/<model>` instead call Account Pooler directly from OptBot.

Account Pooler does not offer this to plugins. With the setting on, OptBot reads
Account Pooler's machine token from BB's data folder for each summary and sends
the request to its local proxy; the token is never logged or stored. A future BB
release may break this, so it stays off unless you turn it on.

OptBot finds the CLI on the BB daemon's `PATH`. If that finds a wrapper script
(for example a version manager's shim) that hangs, each summary call stops after
90 seconds and the error says so; point OptBot at the real binary:

```sh
bb plugin config optbot set compactorExecutable /absolute/path/to/pi
```

## Use it

- **Create a bot:** the **+** in the OptBot sidebar header offers Bot, Section and
  Project. A bot has a name, role, instructions (SOUL.md), projects and an avatar.
- **Start a conversation** from the bot in the sidebar and choose any installed BB
  provider and model. OptBot conversations start from the sidebar; OptBot does not
  appear in BB's regular new-thread picker.
- **Switch models** in the conversation's composer picker. It lists every
  installed provider's models with the provider shown beside each; large
  catalogs are under **More models**. The next turn uses the new model and keeps
  the memory. Choosing another provider's *tab* is BB's handoff and starts an
  ordinary thread outside OptBot.
- **Inspect memory:** right-click a bot → **Edit bot → Memory** shows the history
  and summary tree as JSONL, the current view, and how any summary was merged.
- **Orchestrate:** a bot can run the `bb` CLI, so it can start and manage BB
  threads when you ask. Threads it starts are ordinary sidebar threads.

## Subagents

When you ask for it, a bot splits work across subagents (`optbot_spawn`). Each
subagent is an ordinary BB thread under the conversation that started it, titled
with its task, on the same provider and model, and known by its thread ID. The
bot never waits for one: when a subagent finishes, fails or is interrupted, BB
tells the conversation, and the bot's memory logs that notice as the agent's
report (`work`, starting `[thr_…]`). The bot can message a running or finished
subagent (`optbot_tell`) and read its whole chat from its BB thread.

A subagent starts from its task alone, without the bot's memory, so a side task
never sees the rest of your work. The bot passes its view along only when the
tasks build on the conversation.

Each turn runs in a hidden thread that is closed when the turn ends, which would
cut off a provider's own subagents. Turn on BB's **Disable provider subagents**
setting for Codex and Claude Code (and **Disable Workflow tool** for Claude Code)
so all delegation goes through OptBot's subagents:

```sh
bb plugin config provider-codex set subagentsDisabled true
bb plugin config provider-claude-code set subagentsDisabled true
bb plugin config provider-claude-code set workflowsDisabled true
```

These settings apply to every Codex and Claude Code thread, not only OptBot's.

## After a restart

A BB restart cuts the turns running at the time. Once BB is back, each cut turn
starts again with "The server restarted, cutting OptBot's turn; nothing was lost:
go on.", and subagents the restart cut are told the same. Nothing you sent is
lost: messages that waited on the cut turn are kept in order.

## How the memory works

Each bot has one memory, shared by all of its conversations and isolated from
other bots. It follows UniiChat's source
([VictorTaelin/UniiChat](https://github.com/VictorTaelin/UniiChat), formerly OptChat):

1. **The log.** Every user message, reply, tool call, tool result and report from
   another thread, bot or subagent (`work`, starting `[sender]`) is appended to daily JSONL
   files and never edited. Tool results keep 30,000 characters (start and end);
   any other longer text is logged as several messages in a row.
2. **The tree.** In the background, each message is compressed into a line of at
   most 512 bytes, and adjacent lines are merged pairwise into a binary tree. A
   message or pair that fits in 512 bytes is its own line, word for word. Up to 64
   summaries per bot run at once (8 in total through a CLI summarizer).
3. **The view.** Every turn sees the whole history as summary lines, recent ones
   fine and old ones coarse. Each new message appends a line; once the view passes
   128 KB, one batch merges the most due pairs (Taelin's rollback-push order) down
   to 64 KB. The view is saved (`view.json`) and never rebuilt.
4. **The turn.** Each message starts a fresh worker with the spec's system prompt,
   the view and your message. When a line is too vague, the agent calls
   `optbot_memory` to zoom into it, down to the original message, or to date it.
5. **Summaries** use the same system prompt and a smaller 16-32 KB view of their
   own, with the spec's task text and a 512-dash ruler.

## Operator commands

```sh
bb optbot list [--json]                              # bots and their IDs
bb optbot message <bot> "<message>"                  # queue a message for a bot
bb optbot model check                                # test the summarizer
bb optbot memory view <bot-id>                       # the current view
bb optbot memory browse <bot-id>                     # writes an HTML page; prints its path
bb optbot memory backup <bot-id>                     # writes a JSON backup; prints its path
bb optbot memory import <bot-id> @/path/backup.json  # restore or import history
```

Backups and browse pages are written to OptBot's data folder
(`exports/<bot-id>/`) because BB limits command output to 1 MB. Imports are
operator-only; an agent cannot rewrite its own history.

## Data and privacy

Everything stays in OptBot's BB plugin data folder: `chat/<bot-id>/` (the log and
tree), `state/` (bot identity files), `exports/` and `data.db` (indexes and
sidebar metadata). Nothing is sent anywhere except to the providers you choose.
The memory view and the original messages the agent opens enter that provider's
context. Back up the data folder; the log is the bot's memory.

## Requirements and limits

- BB 0.44 or newer, Plugin SDK 0.5.29 or newer, and at least one installed BB
  agent provider for conversations.
- A Codex, Claude Code or Pi login on one BB machine for the summarizer (or an API key).
- Turns always run with **Full access** on the chosen provider; Plan mode is not
  available in OptBot conversations.
- Prompt caching is handled by each provider; OptBot cannot set the spec's cache
  breakpoints through BB threads.
- Hiding OptBot from BB's global picker uses `experimental_visibility`, an
  experimental BB setting that a future BB release may change.

## Develop

```sh
npm install
npm test
npm run typecheck
bb plugin build
bb plugin install . --yes   # install from this checkout
```

See [AGENTS.md](AGENTS.md) for the contracts the code keeps.

## Credits and licenses

- Sidebar, bot management and coordination: [Bots Sidebar](https://github.com/tobi/bb-bots-sidebar)
  by Tobias Lütke, of which OptBot is an extension.
- Memory design: [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
  by Victor Taelin; the summarizer and system prompts are taken from it verbatim.
- Avatar shapes adapted from [bloub](https://github.com/jeremy-prt/bloub) (MIT);
  see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
