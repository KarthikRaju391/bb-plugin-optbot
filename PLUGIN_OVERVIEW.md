OptBot is an extension of [Bots Sidebar](https://github.com/tobi/bb-bots-sidebar) by Tobias Lütke. It keeps the Bots Sidebar experience (named bots, avatars, sections, project roles, conversation trees, `@` mentions) and replaces how a bot remembers with [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449), Victor Taelin's design (now called UniiChat) for an endless chat whose history is its memory.

## What you get

- One memory per bot, shared by all of that bot's conversations and isolated from every other bot.
- Every message, reply and tool call is kept word for word, append-only, in daily JSONL files; tool results keep up to 30,000 characters (start and end).
- Each turn starts fresh: the bot reads a bounded view (64-128 KB) of its whole history, recent messages one per line and older ones summarized in larger blocks, then your new message. Its context never grows and is never compacted away.
- When a summary is too vague, the bot zooms into it, line by line, down to the original message.
- Corrections stick: your own words rank first when history is summarized, so the latest decision is what the bot remembers.
- Switch the model in the conversation's composer at any time; the next turn uses it and keeps the memory.
- Edit bot → Memory shows the history, the summary tree and the current view, and how each summary was merged.
- Subagents on request: a bot splits work across BB threads under its conversation, titled with their tasks, and each one's report reaches the bot as soon as it finishes. The bot never polls.
- A BB restart loses nothing: each cut turn, and each cut subagent, goes on once BB is back.

## How it works

Start a conversation from the OptBot sidebar and pick any installed BB provider and model. Each turn runs as a hidden BB thread on that provider, with its normal login, tools and Full access. OptBot records what happened and builds the summaries in the background. OptBot does not appear in BB's regular new-thread picker; its conversations start from the sidebar.

Operators can inspect, back up and restore a bot's history with `bb optbot memory view`, `browse`, `backup` and `import`.

## Requirements

- BB 0.44 or newer with Plugin SDK 0.5.29 or newer.
- At least one installed BB agent provider for conversations (Codex, Claude Code, Pi or an ACP agent). Its normal usage costs apply.
- Summaries are written through an existing Codex, Claude Code or Pi login on one BB machine, set in OptBot's settings. No API key is needed.
- Turns always run with Full access on the chosen provider.
- Hiding OptBot from the global picker uses an experimental BB setting that a future BB release may change.

This is an early release.
