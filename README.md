# OptBot

OptBot retains the Bots Sidebar UI, bot identities, sections, avatars, project
roles, native conversations, and coordination. Its `optbot` provider runs each
bot as an OptChat: a fresh model session for each turn, reading that bot's durable
conversation tree instead of resuming a provider's growing context.

This is a separate, local plugin derived from
[tobi/bb-bots-sidebar](https://github.com/tobi/bb-bots-sidebar), revision
`08d93d3721e297ca2393ed09f1965c94bfcedc74`, implementing the required mechanics of
[Victor Taelin's OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449).
It is a BB adaptation of that specification, not the upstream OptMem CLI.
No original plugin installation or live bot records are changed by building it.

## Conversation runtime

- One canonical append-only conversation log and binary summary tree per stable
  bot ID, shared across that bot's conversations. Daily JSONL streams live in
  private `chat/<bot-id>/main/` and `tree/` directories. Writes are fsynced;
  originals, their permanent IDs, and timestamps are never replaced by summaries.
- The specification's **byte** constants apply: NODE=512, VIEW=128,000,
  CAP=30,000 characters. The view budget counts node text, not its address/tag
  overhead. Short nodes are free verbatim copies. A persistent in-memory/cache
  view is folded incrementally, joining stored sibling nodes according to the
  specification's due/age rule; completed parents do not trigger global retiling.
- An always-on backend compactor uses up to eight concurrent jobs, with no
  duplicate work and no reads of an unbuilt context prefix. Each node has one
  five-attempt dialogue, a byte-exact SCALE illustration, and byte-safe feedback.
  The shortest actual candidate is retained even after five overshoots. Failed
  jobs are reported once and retried after ten seconds; no fake summary is used.
- Each master turn reads only a settled view, then starts a fresh provider
  conversation with constant MASTER/VIEW_DOC/instruction headers, that view, and
  the complete current input. The tool loop and mid-turn messages continue inside
  that call; signed/encrypted reasoning is preserved for provider caching but
  excluded from the conversation log. Completed thoughts can stream to the UI.
- BB models execute in fresh **hidden BB worker threads**, using the selected
  installed provider, its authentication, native tools, and execution environment.
  OptBot owns the memory view and durable transcript, not a parallel provider
  transport. Native caching/reasoning retention belongs to the selected provider.
  OpenAI Responses and Anthropic Messages remain explicit API alternatives.
- `zoom(id,n)` and `date(id)` implement the reference navigation tools. The
  compatibility `optbot_memory` tool adds paginated literal search and leaf
  paging. Both are scoped to the caller's bot. User instruction files
  `AGENTS.md`/`CLAUDE.md` are included unchanged in append mode.
- Per-bot leases serialize turns across conversations, with heartbeats and
  stale-lease recovery. Loss of the lease service aborts the active model. A
  completed model answer is checkpointed before compression, so repairing failed
  compression does not execute the completed model turn a second time.
- Failed/interrupted attempts remain in history with uncertainty warnings.
  This is **not** an exactly-once guarantee for external side effects: a crash
  after a remote action but before its response is recorded still needs human or
  service-level reconciliation.

### Run without an API key

Choose an installed provider in BB's native conversation composer. OptBot wraps
that selection as `bb/<provider>/<model>` and runs a fresh hidden BB worker for
each master turn. The visible conversation remains on the `optbot` orchestration
provider so selecting another execution provider does not bypass memory.
Existing `bb/codex` conversations now delegate to BB's installed Codex provider.
OptBot publishes no second selectable model catalog or cold-cache fallback list.
Wrapped model identities are returned as `selectedOnlyModels`, solely to resolve
an existing conversation's native selection. BB SDK 0.5.29 has no internal/hidden
provider policy or per-composer provider filter, so the OptBot provider tab can
still appear. Removing that tab while retaining orchestration needs a BB API
change; choosing a native provider directly on an existing outer thread bypasses
the OptChat bridge.

### Inspect bot memory

Right-click a bot → **Edit bot → Memory**. The read-only inspector pages the
canonical history and summary tree as JSONL records and shows the current memory
view plus settled/pending status. Tree addresses are `start = i × 2^l`,
`count = 2^l`; enter a start/count to compare a parent with its two source children.
Short nodes are verbatim copies, not model-generated summaries. Original messages
remain available in History JSONL. JSONL is reserialized from canonical records,
not a byte-for-byte export of the daily files; pages can split a record. Pagination
detects intervening memory changes and restarts at the beginning rather than
combining mismatched snapshots. Parent/child previews are bounded and show a
truncation notice; the JSONL pages retain the full stored text.
The existing **State** tab edits optional pinned context; it is not this history
or the automatic summary tree. Neither tab is added to bot creation.

Set **Compactor BB machine ID** to an enrolled machine with the chosen provider.
The default `compactorModel` is `bb/codex`; any `bb/<provider>/<model>` selection
uses the same native worker service. Authentication stays with BB. The configured
machine must remain online for large-message compaction. Example operator setup:

**Safety gate:** automatic native background compaction is paused by default.
BB's public worker API cannot disable every provider-native tool. Processing
untrusted historical text with those tools is therefore not a text-only boundary.
The operator may explicitly enable `allowNativeSummaryTools` after accepting that
risk, or choose a text-only API summarizer. Without either, long-message
compaction remains pending and can block the next settled memory view. The
benign, operator-requested readiness check still works without this opt-in.

```sh
bb plugin config optbot set compactorHost <machine-id>
bb plugin config optbot set compactorModel bb/codex
bb plugin reload optbot
bb optbot model check
```

Provider availability, login, account routing and native tools are BB's concern.
Master workers reuse the visible conversation's environment and requested
permissions. Their OptBot memory/state tools are scoped to the originating bot;
internal worker/control tools are not injected into them. Completed worker
messages and native tool receipts enter canonical history; reasoning does not.
Workers are hidden and archived on completion/cancellation. They consume BB
concurrency slots, so the host needs capacity beyond the visible conversation.

`bb optbot model check` executes a small readiness summary through an actual
hidden BB worker and returns the model, machine ID, and generated text. It does
not write bot history. It consumes a provider call and archives its worker.

For explicitly selected API models only, the execution host needs
`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. The API compactor instead uses the secret
`compactorApiKey` setting (or the backend environment key) and optional
`compactorEndpoint`. Never paste credentials into chat. Custom API endpoints use
`OPTBOT_OPENAI_BASE_URL`/`OPTBOT_ANTHROPIC_BASE_URL`, must support the selected
protocol and HTTPS (loopback HTTP permitted), and must keep keys out of URLs.

Native worker permissions are forwarded without escalation. Native Plan mode is
currently rejected before spawning; approval/question interactions remain on the
worker's BB timeline rather than being mirrored into the visible conversation.
Direct API execution still requires explicit **Full access**; its Plan mode
omits write/shell/native mutation tools. Local-file
attachment paths are retained; inline/remote image payloads are rejected rather
than silently discarded. This is the reference's text-memory runtime, not a new
multimodal attachment service. Optional subagent/computer-job executors from §9
are not implemented here; existing sidebar coordination remains unchanged.

## Private memory operations

The operator CLI can import a JSON array of `{i?,kind,text,date?}` entries while
the bot is idle. Supplied IDs and dates are validated and preserved, not repaired;
conflicting entries or incomplete imported subtrees fail before writes. For large
imports, send sequential bounded chunks rather than exceeding shell argument
limits. A backup JSON object can be supplied to the same import command.

- `bb optbot memory import <bot-id> '<JSON-array-or-backup>'`
- `bb optbot memory view <bot-id>` — bounded current view; no model call.
- `bb optbot memory browse <bot-id> > memory.html` — private, escaped HTML with
  the current view, full ROOT messages, all stored levels, ranges, dates and sizes.
- `bb optbot memory backup <bot-id> > memory.json` — canonical transcript/tree
  export. Keep exports private and outside Git; also back up the plugin database
  for sidebar identities, bindings, leases and answer checkpoints.

Contextual agents can read only their own bot and cannot import history. The
plugin's Unix socket is the lifetime writer lock; a short OS-held startup mutex
prevents stale-socket cleanup races. There are no PID-file/expiry writer locks.
BB reloads share the same process-owned writer/compactor. Invalid JSONL lines are
reported and skipped, missing final newlines repaired, and unsafe/conflicting IDs
fail closed. SQLite transcript/node indexes can be reconstructed from the files;
metadata is not confused with generated Markdown exports. A durable inbox keeps
received but unconsumed inputs across stop/restart. Long compaction can delay the
next turn, but completed answers do not wait for background compaction.

Live vendor acceptance and cache-hit counts still require authenticated API
verification. Local mocked-HTTP tests prove request layout and runtime behavior,
not actual cache hits, model-summary quality, or successful deployment.

The sidebar implementation and its feature reference follow below.

Bots are identities, not projects or working directories. A bot has a name,
avatar, operating instructions, memory, and linked projects. Its state stays
private in BB and follows its conversations through embedded instructions and
bot-scoped tools.

Ordinary bot conversations are projectless. Explicit project/worktree starts can
choose any available work project and join the selected bot to it. Creating a bot never creates a
backing BB project or writes `SOUL.md` into a repository.

## Preview

[Open the screenshot gallery](docs/screenshots/index.html). All illustrations use
synthetic data; private-session captures do not belong in published assets.

Demo data only: [Sidebar](docs/screenshots/sidebar.png) ·
[Activity badge](docs/screenshots/bot-activity.png) ·
[Hover archive](docs/screenshots/conversation-hover.png) ·
[Drag to assign](docs/screenshots/conversation-drop.png) ·
[Create bot](docs/screenshots/bot-create.png) ·
[Edit bot](docs/screenshots/bot-editor.png) ·
[Project roles](docs/screenshots/bot-projects.png) ·
[Create menu](docs/screenshots/create-menu.png) ·
[Project during bot creation](docs/screenshots/bot-new-project.png) ·
[State in Edit bot](docs/screenshots/bot-state.png) ·
[Appearance choices](docs/screenshots/bot-appearance.png)

## Private state

The plugin's SQLite database is the durable authority for sidebar metadata,
explicit pins/settings, bindings and turn checkpoints, not transcript/tree text.
Generated Markdown/JSON
exports live under the plugin's own BB data directory at `state/<bot-id>/`, with
private directory/file permissions. They are keyed by stable bot IDs, not names,
and are not execution workspaces. Agents do not need their physical locations.

| Logical file | Purpose |
| --- | --- |
| `SOUL.md` | Identity and personality; up to 4,096 characters |
| `MEMORY.md` | Compatibility editor/export for pinned context; at most 3,000 characters, not the conversation memory |
| `settings.json` | Structured bot preferences; a JSON object up to 16,384 characters |

**Edit bot** is the single editor: **Instructions** contains SOUL.md;
**State** contains MEMORY.md / settings.json. Its explicit Save commits changes
together with revision/hash checks; invalid JSON or conflicts never partially save
other fields. Use this editor or the state tools—not direct edits to exports.
Export failures do not lose committed state or prevent conversations.
The working machine can be offline while state is still readable/editable in BB.

Sessions receive fixed tool/storage guidance, a bounded SOUL excerpt, and the full
current pinned context (up to 3,000 characters), independently of the transcript tree. There is no per-bot AGENTS instruction
layer. Old bot AGENTS text remains archived in private storage and is not injected,
editable, or newly exported. Existing oversized memories remain readable without
truncating stored data; condense them before writing memory again. Existing provider sessions pick up changed system
instructions when they are reconstructed; tool reads always see current state.
The current project's own `AGENTS.md` continues to apply. Bot state is never
copied into that project's directory.

## Project roles

**Edit bot → Projects** shows only the bot's linked projects. Use **Add existing…**
to search for a project, **New project…** to create one, or **×** to unlink.
Each linked project has a **Member / Owner** selector.
Projects may have many members but only one owner. Claiming an already-owned
project is rejected; release its current ownership before assigning another bot.

- **Owner:** new ordinary project conversations default to this bot.
- **Member:** an explicitly selected bot, or inherited parent/fork bot context,
  overrides that default. Starting under a bot joins it to the selected project
  if needed, without changing the project's owner.
- Existing conversations and main pointers never move. Ownership does not capture
  older unassigned conversations, including ones still waiting for their first send.
- Releasing ownership keeps membership. Leaving also releases ownership, without
  changing existing conversation bindings. Projectless chats stay projectless;
  personal and legacy bot-home projects cannot be owned.

Ownership is conversation routing, not filesystem ownership or an access-control
change. Existing memberships are **not** promoted automatically; choose Owner to
opt in. Role changes are atomic and survive reloads.

## Creating bots, sections, and projects

The **+** in the Bots header opens **Bot / Section / Project**. Standalone project
creation opens that work project without creating a bot.

You can also create a work project directly inside a new or existing bot's
**Projects** tab. Choose a machine and folder (or use **Browse…**). Missing folders
are created; existing files are not changed. The new project is selected as
**Owner** in the bot draft; click **Create bot / Save bot** to save that link.

**Create project** is an explicit, immediate action. Cancelling the bot afterwards
does not delete that project or its files. Unsaved project forms create nothing.
Retries retain the same request ID to avoid duplicate projects. Existing folder
registrations are rejected rather than silently reused. Bot state stays private
in BB; a bot still needs no project or special working directory.

## State tools

- `optbot_read_state({ target })` reads identity, pinned context, settings, or project roles.
- `optbot_update_state({ target, action, ... })` is the durable-write gateway for those explicit settings, not for conversation history.
- `optbot_memory({ action: "view" | "search" | "zoom", ... })` reads the current bot's conversation tree. `search` accepts a literal `query` and `after` cursor; `zoom` accepts `start`, `count`, and an optional leaf `offset`.
- `optbot_chat` and `optbot_worker` are private orchestration transports, not worker-model tools.

| Target | Action | Inputs / behavior |
| --- | --- | --- |
| `identity` | `set` | Fresh `expectedRevision`, plus name, role, and/or soul |
| `memory` | `append`, `forget` | One exact single-line `fact`; append deduplicates; resulting memory must fit 3,000 characters |
| `memory` | `overwrite` | Full replacement `content` (max 3,000 characters) and fresh `expectedSha256` from a memory read; no retry on conflict |
| `settings` | `set` | `values` merges selected top-level keys |
| `settings` | `unset` | `keys` removes only those keys |
| `project` | `join`, `leave` | Existing `projectId`; leave also releases ownership |
| `project` | `own`, `release` | Claim an unowned project (also joins), or release ownership while remaining a member |

For example:

```json
{"target":"memory","action":"append","fact":"The user prefers concise progress updates."}
```

All operations are scoped to the current bot. Tools cannot choose another bot or
an arbitrary path. Writes use SQLite transactions and expected hashes/revisions;
semantic memory/settings changes retry bounded conflicts against current state.
Memory reads include full content, sha256, characters, and maxCharacters. If memory
is full, read it, condense it, then overwrite with that hash. Whole-memory overwrites
never retry against a newer document; read and merge again after a conflict.
Fixed guidance uses BB’s static tool-instructions field. Dynamic identity/memory
stays within BB’s 4,096-character limit, retaining full compliant memory and
shortening the SOUL excerpt as needed.
Unused optional tool fields may be omitted or null. Shared memory, routines,
channels, and scheduled skills are deliberately out of scope. Never store secrets
in bot state.

## Sidebar interactions

- Click a bot to open its main conversation and show all active top-level
  conversation trees first, plus up to **five inactive** trees. Remaining inactive
  conversations sit behind **N Other**; active work never consumes the five slots.
  Right-click for a new projectless
  conversation, project/worktree work, Edit, visibility,
  and Move main. Existing main/history stays intact until replacement is sent.
- Drag an unassigned conversation from **Chats** onto a bot, or use **Assign to
  bot…** from its menu. Any bot can be chosen; it joins the conversation's work
  project as a member if needed. Projectless chats need no project link. History,
  project, environment and existing child assignments stay unchanged. A drop does
  not navigate away; use the confirmation's **View** action to open it.
- Hover a conversation row to reveal its archive button, also available on
  keyboard focus and touch. It sits inline before the child count, never covering
  the title or disclosure. This uses BB's normal archive action, including children.
- Each conversation's right-edge count/chevron reveals only its own children,
  collapsed by default. The bot-row count refers only to the **main conversation's
  children**, never the independent topics. Those children appear in a separate,
  directly connected, more-indented tree above the other top-level conversations,
  without extra labels or a divider.
- Working/waiting descendants keep their root visible. Viewed and pinned inactive
  branches take priority within the five slots; unread completions still count as
  inactive. Children keep independent toggles, and navigation reveals the viewed
  ancestor path without opening overflow. Chats retains its separate overflow.
- The avatar's bottom-right spinner shows its **main** working. Small pulsing dots
  to the left show other working conversations—even when collapsed. Three slots
  keep it compact; a **+** indicates overflow and the tooltip gives the exact count.
  Other work never makes an idle main look busy. Waiting/errors remain distinct.
- Working conversation rows spin; completed ones are green dots while unviewed,
  then smaller gray dots. Reduced motion disables all activity animations.
- **Main** is the invisible default section. Explicit custom sections retain their
  headings. Drag bots to reorder/move; the Section picker includes **Create New…**.
- Create/Edit stays compact: small avatar, name/role, Setup / Instructions / State /
  Projects / Appearance tabs, one file editor, and an always-visible footer.
  New bots get a random appearance once per draft; existing bots stay unchanged.
  Appearance offers **8 shapes, 16 expressions, 3 idle motions, and 14 coloured
  presets**, with no black/white/neutral presets. **Randomize appearance** rerolls
  explicitly. Existing/custom hex colours remain supported.
- Sidebar faces occasionally show a brief idle expression (3–5 seconds, spaced
  5–12 minutes apart). After 30 minutes without activity they look bored; after
  two hours, sleepy. Work, pending input, and unread errors restore the chosen face.
  These are display-only changes: saved appearance and editor previews stay intact.
  Random bursts pause in hidden windows and are disabled by Still/reduced motion.
  Machine is an execution default, never the state storage location.
- All **New conversation** actions open the same native composer popup immediately,
  without a separate project-selection step. Ordinary chat starts projectless;
  **in project** selects a checkout; **in worktree** selects a fresh worktree.
  The current work context or a linked project is preselected, and you can change
  the project, machine, and harness inside the popup before sending.
- **New conversation in worktree…** selects a fresh managed worktree on the
  originating conversation's machine (or the bot's main/default machine), never
  reuses the existing worktree. The picker remains editable; if that machine lacks
  a project source, BB may fall back to an available source.
- Save is explicit; Enter never submits text fields. Drafts survive tab changes.
  No sidebar overlay toolbars or activity dates; the hidden toggle stays at bottom.
- Chats contains unassigned conversations and is collapsible/resizable. Several
  bots may share a project without sharing identity or conversation ownership.

## Plugin identity

The runtime ID is **`optbot`**, derived from package **`bb-plugin-optbot`**.
Use `bb plugin reload optbot` for this plugin. Provider, sidebar, mentions, CLI,
and client storage keys are namespaced separately from Bots Sidebar. New bot
conversation composers use BB's native provider picker; execution is wrapped by `optbot`.

Installing this separate plugin does not automatically import live Bots Sidebar
records or change existing conversations' providers. A live migration needs a
consistent backup, a reviewed import preserving bot IDs and bindings, and new
OptBot conversations while keeping old history. That cross-plugin migration is
not implemented or performed in this checkout. New conversations started through
OptBot retain the selected installed execution provider inside the OptBot wrapper.
Existing non-OptBot conversations are
not converted by assigning them to a bot.

## Migration and cleanup

The inherited migrations apply only to legacy records already in OptBot's own
storage namespace, not to the separately installed Bots Sidebar. Existing IDs,
sections, avatars, linked projects, main pointers, and conversation bindings in
that namespace are preserved. Version-2 home state is imported once after verifying its
ownership marker. Missing/offline/corrupt sources fall back to that bot's own cached
state with a warning; later source changes never overwrite newer private state.
Version-1 project-backed records are still imported from a one-time snapshot,
including reconciled live/archived history. Ordinary/new projects never become
bots automatically.

Migration never deletes or modifies legacy source files, project folders, or
conversations. Old home projects are retained for existing history but are not
used for new bot launches. Choose **Move main** to replace an old project-bound
main with a fresh projectless conversation while keeping its history.

Cleanup of old generated project `SOUL.md` / `bot.json` files is a separate,
owner-approved operation: compare against saved migration hashes, keep tracked or
independently changed files, and move eligible files into private backups. Never
remove a project's `AGENTS.md`. Keep a consistent plugin database backup before
switching storage versions; the prior code checkpoint is
`checkpoint/home-project-bots`.

## Develop

Use a BB release supporting plugin SDK 0.5.29 and provider bridge grammar 3, and
Node.js 24 or newer. No BB-core source modification is required.

```sh
cd bb-plugin-optbot
npm ci
npm run typecheck
NODE_OPTIONS=--no-experimental-webstorage npm test
bb plugin build
```

The Node option prevents Node 25's experimental global localStorage from
colliding with the jsdom UI harness. The local OptChat functional harness is in
`.local/`; run it with `NODE_OPTIONS=--no-experimental-webstorage npx vitest run
--config .local/vitest.config.ts`. It mocks model/network responses and uses
actual BB test-host routing, native protocol schemas, event assembly and SQLite.
It does not establish live model quality, authentication or deployment success.

Install with `bb plugin install . --yes` and choose **OptBot** in Settings → Sidebar.
For the default no-key path, use an execution machine already signed into its selected BB provider
and configure that machine for background compaction as above. Rebuild/reload an
existing local installation with `bb plugin build && bb plugin reload optbot`.
Do not install as an in-place rename of Bots Sidebar; migration remains separate.

This fork retains the upstream sidebar implementation. Avatar
appearance options are adapted from [bloub](https://github.com/jeremy-prt/bloub).
See [third-party notices](THIRD_PARTY_NOTICES.md) for its MIT attribution.
Dependencies are installed independently; no other BB plugin is required.

### Bot coordination

Type **@** followed by a bot name, role, or ID in a composer. Results appear under
**OptBots**; **@optbots** lists the available bots, including ones hidden from the sidebar.
Mentions use stable bot IDs, so duplicate names and later renames do not redirect
an existing reference. Selecting a bot inserts a mention—not a message or an
assignment. At send time it supplies only public name/role/ID and messaging guidance,
never that bot's private SOUL, memory, or settings.

Bot context states the current project relationship: owner, joined member (with the owner's name and ID), or not joined. Personal chats have no work-project role. `optbot_read_state({"target":"project"})` refreshes this relationship alongside linked and available projects. Ownership routes new project conversations; it does not grant authority over other agents or the user.

```sh
bb optbot list
bb optbot list --json --limit 50 --offset 0
bb optbot message <bot-id-or-exact-name> "Please review the changes"
bb optbot message <bot-id> "My reply" --thread <sender-conversation-id>
```

Messages use BB's native queue: idle conversations start a turn, busy conversations receive the message later. The default destination is the recipient's existing main conversation; `--thread` must belong to that bot. Messages identify the invoking conversation and its bound bot, clearly distinguish agent coordination from user instructions, and include an asynchronous reply command. FYI messages need no acknowledgement. Unbound conversations and external CLI callers are labeled accurately. The CLI does not create conversations or change membership, bindings, permissions, or private state.

Listing exposes public bot metadata only and paginates at 100 bots maximum. Names must match exactly; use IDs for duplicate names. Quote messages (maximum 12,000 characters). Delivery receipts confirm acceptance, not task completion or a reply.

`bb optbot list` also shows **STATUS**, **VISIBILITY**, **OWNED PROJECTS**, and
**JOINED PROJECTS** by name. Joined projects are memberships without ownership;
JSON includes both project IDs and names. The first column is the stable bot ID
accepted by `bb optbot message`. Activity aggregates all non-archived bot conversations,
including inherited children and hidden conversations: waiting takes precedence over
working, then error, then idle. Visibility separately reflects the bot's hidden setting.

Incoming bot messages use BB's native attributed, expandable agent-message row
and sender-conversation link. Inside it, a **🤖 Bot message · Name** heading and
the original message come first; delivery context and the exact reply command follow
under a separator. This keeps the content easy to scan while preserving the agent's
attribution and asynchronous handling instructions. No custom timeline renderer is used.
