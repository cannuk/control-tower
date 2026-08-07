# Control Tower — Plan

A desktop dashboard for in-flight Claude Code sessions. Named for the job it does:
you have many sessions taking off, circling, and landing — this is the overview that
keeps them all moving.

Sibling in spirit to [new-day](https://github.com/cannuk/new-day): the same idea that you
can switch the whole look at runtime, same personal-project posture. Nothing else is
inherited from it — the stack below is chosen on merit, not for parity.

---

## 1. Stack

Versions are the current latest, checked against npm rather than assumed.

| Layer | Choice | Why |
|---|---|---|
| Shell | **Electron 43** | The Node answer for desktop. Main process gets real `fs`/`child_process`, which this app is entirely built on. Tauri would mean Rust. |
| Build | **electron-vite 5** | Current best DX for Electron+Vite: one config for main/preload/renderer, HMR on the renderer, `import.meta.env`. Lighter than Forge's plugin. |
| Package | **electron-builder** | DMG + auto-update later if wanted. |
| UI | **React 19.2 + TypeScript 5.8** | 19 is the current major — there is no React 20. Not chosen for parity with new-day, which is still on React 18. |
| UI kit | **shadcn/ui + Radix** on **Tailwind 4.3** — see §3 | Radix gives real a11y and full density control; themes are our own CSS-variable sets. |
| State | **Zustand 5** | New-day uses Redux Toolkit, but this app's state is one pushed snapshot. RTK is overkill; Zustand is ~1KB and reads cleanly. |
| Local store | **SQLite via `node:sqlite`** — see §4 | Bundled with Electron 43 (Node 24.18), so no native module and no rebuild step. |
| Lint | eslint + prettier + husky + lint-staged | Same as new-day. |

Deliberately **not** using: a backend service, or auth (single-user, local).

---

## 2. Where the data comes from

Four independent local sources, joined on the Claude `sessionId`.

### 2.1 Session registry — liveness and status
`~/.claude/sessions/{pid}.json`, one file per running CLI:

```json
{"pid":83534,"sessionId":"7f93a14d-…","cwd":"…/chat-sdk",
 "startedAt":1786109703546,"procStart":"Fri Aug  7 13:35:00 2026",
 "version":"2.1.224","entrypoint":"cli","kind":"interactive",
 "name":"chat-sdk-1f","nameSource":"derived",
 "status":"busy","updatedAt":1786111465851,"statusUpdatedAt":1786111465851}
```

- `status` is `busy` | `idle` — a real heartbeat, far better than file mtime.
- Entries are **not** cleaned up reliably; verify each `pid` still belongs to a `claude`
  process before trusting it. `procStart` is the PID-recycling guard — but note it is
  rendered in **UTC** while `ps -o lstart=` is **local**, so compare `startedAt` (epoch ms)
  instead. Naive string comparison silently reports zero live sessions.
- `entrypoint: claude-vscode` entries carry **no** `status` field. Fall back to mtime.
- `sessionId` here is the session at *process start* and can drift after `/clear`. Prefer
  the terminal provider's value (§2.3) and validate that a transcript exists.

### 2.2 Transcripts — last interaction and PR links
`~/.claude/projects/{mangled-cwd}/{sessionId}.jsonl`

- **Last interaction** = file mtime. This is the sort key for the active list.
- **PR links** are first-class records on their own line:
  ```json
  {"type":"pr-link","sessionId":"…","prNumber":2520,
   "prUrl":"https://github.com/example-org/web-app/pull/2520",
   "prRepository":"example-org/web-app","timestamp":"2026-08-01T01:25:02.899Z"}
  ```
  Written on `gh pr create` and on later REST linking. Mapping is many-to-many: one PR can
  have several sessions, one session several PRs.
- Folder names are lossy (`_` and `/` both become `-`). Resolve the real cwd by preferring
  a folder name that verifiably exists, then the `cwd` field inside the JSONL.
- Files reach 20MB+. **Never full-read.** Cache `{mtime, size, lastByteOffset}` per file
  and parse only the appended tail — JSONL is append-only.

### 2.3 Terminal provider — the summary and the focus verb
Claude Code does **not** store a semantic summary. Verified: zero `{"type":"summary"}`
records across 107 transcripts; `sessions-index.json` has the field but is dead (v1, last
written in January, zero populated); the registry's `name` is cwd-derived (`chat-sdk-1f`).

The summary belongs to the terminal. For cmux it comes from its `hooks claude auto-name`
hook (a `Stop` hook with a 120s timeout — it's an LLM call).

**cmux exposes a complete Unix-socket control API**, and `surface.list` gives us
everything in one call:

```jsonc
{ "id": "D1FA9BC1-…", "ref": "surface:43", "focused": true,
  "title": "⠐ Check new day skill status",          // the summary (strip leading glyph)
  "requested_working_directory": "…/chat-sdk",
  "pane_id": "…", "pane_ref": "pane:19",
  "resume_binding": {
    "kind": "claude",                                // discriminator: claude|codex|opencode
    "checkpoint_id": "7f93a14d-…",                   // ← the Claude sessionId
    "command": "… claude --resume 7f93a14d-… --permission-mode auto",
    "approval_policy": "auto", "cwd": "…" } }
```

Focus is `surface.focus` (CLI: `cmux focus-panel` / `tab-action`). `cmux events --reconnect`
is a push event stream, so cmux state needs no polling at all.

**The socket does not know about every session, and this is the trap in the whole approach.**
cmux materializes surfaces lazily, so `surface.list` returns only the *open* workspace's tabs.
Measured: **4** surfaces against **20** claude panels cmux had persisted and **22** processes
actually running. `all_workspaces: true` changes nothing — the surfaces genuinely do not exist
yet. So the socket is the exact-and-live source, and cmux's persisted store
(`session-com.cmuxterm.app.json`) is the complete one. Both are needed: see §5.

### 2.4 GitHub — PR state
Via the `gh` CLI (already authenticated as `cannuk`, and that account can read the
`example-org` repos — verified). Shelling out to `gh` avoids storing a token.

One GraphQL query per repo, batching all PR numbers that appear in the session list, with a
fragment per PR pulling `state`, `isDraft`, `reviewDecision`, `statusCheckRollup.state`, and
`reviewThreads(first:100){ nodes{ isResolved isOutdated } }`.

`mergeStateStatus` is deliberately **not** used: GitHub computes it lazily and returns
`UNKNOWN` on a cold query (observed on #2545), so it would need a retry loop to be
meaningful. The four fields above are always populated.

**Cost is a non-issue, and ETags do not apply.** One batched query covering all 50 linked PRs
across 7 repos costs **1 point** against a 5,000/hour limit — so a 60s poll spends about 1% of
budget and the interval is chosen for CI freshness, not to dodge a limit. ETag caching was
never possible here: GraphQL is a POST, so there is nothing to condition a request on. What
does pay off is skipping settled PRs — 37 of those 50 are merged or closed and cannot change,
so they are cached permanently and dropped from later queries.

### 2.5 Summaries — generated by Control Tower, not read from a provider
See §8. The provider title is the fast path, not the mechanism.

---

## 3. Theming and component layer

**Decided: shadcn/ui + Radix on Tailwind 4.** Not daisyUI, and not inherited from new-day.

The requirement is *state of the art in theme and UX* with runtime switching. daisyUI is one
answer to that — and still the strongest for many switchable themes at zero cost — but it was
the wrong axis to optimize here:

| | **shadcn/ui + Radix** (chosen) | daisyUI 5 |
|---|---|---|
| Themes out of the box | none — you define CSS-variable sets | 35, one `data-theme` attribute |
| Component quality / a11y | Radix primitives: full keyboard, focus, and ARIA behavior, unstyled | class-based, moderate control |
| Density control for a dashboard | complete — you own every style | fighting framework defaults |
| Effort to first screen | moderate | very low |

A dense, glanceable dashboard lives on component quality and information density, and this
gives full control of both. The two **cannot be combined** — each owns the Tailwind token
layer — so this is a one-way door, taken deliberately.

### Theme system

Since shadcn ships no themes, Control Tower defines its own — which is the point of the New
Day comparison anyway: what carried over is *switching the whole look at runtime*, not a
particular library's palette set.

- Every color is a **CSS custom property on `:root`**, redefined per theme under a
  `[data-theme="…"]` selector. Same switching mechanism as New Day, our own tokens.
- Ship ~8 curated palettes rather than 35 canned ones, each a light/dark pair, generated and
  then hand-tuned for a dashboard's contrast needs.
- Semantic names, not literal ones: `--status-approved`, `--status-blocked`,
  `--status-running`, `--surface`, `--surface-raised`, `--muted`. A theme swaps values; no
  component knows a color name.

Non-negotiable and unchanged: **status colors come from semantic tokens, never hex**, and every
status carries an icon plus a tooltip so nothing depends on color alone. With hand-rolled
tokens this needs a contrast check per palette, since no framework is guaranteeing it.

---

## 4. Local store — what SQLite is for

Most state here is derived from disk and recomputable, so no database is needed for the live
view. Four things are not derived:

1. **The Ready for Takeoff queue** (§9, M8) — authored by you, exists nowhere else. This alone
   requires durable storage.
2. **Transcript parse cache** — `{path → mtime, size, lastByteOffset, extracted pr-links}`.
   107 transcripts today, several over 20MB; indexed reads beat re-parsing a JSON blob as
   this grows.
3. **PR status + ETag cache** — survives restart, so launching doesn't burn GitHub rate
   limit re-fetching what hasn't changed.
4. **Session history** — the strongest reason. `~/.claude/sessions/{pid}.json` **is deleted
   when a session exits**, and cmux's closed-item history is provider-specific and may
   rotate. If Control Tower is to keep any durable record of past sessions — for the Recent
   tab, or later for "how long do my sessions actually run" — its own store is the only
   place that can live.

**Not** in SQLite: the live session snapshot. That stays derived, in memory, rebuilt from the
four sources on each watcher tick.

**Which SQLite: `node:sqlite`.** Electron 43 bundles Node 24.18, which ships it
(`DatabaseSync`, `StatementSync`, `Session`, `backup`) — verified by probing the actual
Electron runtime, not the system Node. That removes the native module and the
`electron-rebuild` postinstall this plan had budgeted for with better-sqlite3. It is still
flagged experimental upstream, so the surface used is deliberately dull: tables, prepared
statements, one transaction helper. Nothing a minor API change could quietly break.

---

## 5. The terminal provider abstraction

The requirement: clicking a summary focuses the right tab, and switching terminal
providers should "just work". Three layers, best-first — a provider implements as much as
it can and the layers below cover the rest.

```ts
interface TerminalProvider {
  id: string;                                   // 'cmux' | 'wezterm' | 'iterm2' | 'tmux' | …
  detect(): Promise<boolean>;
  /** Sessions this provider knows about, keyed by Claude sessionId. */
  sessions(): Promise<Map<string, ProviderSession>>;
  focus(target: ProviderSession): Promise<void>;
  /** Optional: create a new session — powers "Ready for Takeoff". */
  launch?(opts: { cwd: string; command?: string; name?: string }): Promise<void>;
  /** Push updates instead of being polled. */
  subscribe?(onChange: () => void): () => void;
}

interface ProviderSession {
  sessionId: string;          // Claude sessionId
  title: string | null;       // the semantic summary
  handle: string;             // provider-native focus target (surface ref, pane id, …)
  cwd?: string;
  resumeCommand?: string;
}
```

**Layer 1 — native store (best).** The provider tells us the sessionId directly. cmux does
this via `resume_binding.checkpoint_id`. Exact, no heuristics, and it comes with the title
and a focus verb.

In practice layer 1 is itself two-tier, because of the lazy-surface behaviour in §2.3: ask the
socket first (exact, instant, no side effects), and for a session it cannot see, find the
owning workspace in cmux's persisted store, `workspace.select` it to materialize its surfaces,
then focus. The second path costs a workspace switch — which is what the user asked for by
clicking. Resolution happens at **click time**, never from a handle captured on an earlier
sweep: focusing the wrong tab is worse than failing, because it looks like success.

**Layer 2 — TTY derivation (generic fallback).** Works for *any* terminal, with no
provider support at all. The controlling TTY is the universal join key:

```
registry pid 83534  →  ps -p 83534 -o tty=  →  ttys033
```

Verified: `ttys033` is exactly what cmux independently reports for that panel. Walk `ppid`
up from the claude process to identify the terminal emulator, then focus by tty using
whatever that emulator offers — `wezterm cli list --format json` + `activate-pane`,
`tmux list-panes -a -F '#{pane_tty}'` + `select-pane`, AppleScript for iTerm2/Terminal.app,
`kitty @ ls`. Each is ~20 lines.

**Layer 3 — configured template.** Settings pane accepts a shell template with
`{tty} {pid} {sessionId} {cwd}` placeholders. Escape hatch for anything unknown; also how
a user overrides a misbehaving auto-detect.

Resolution order at runtime: any provider that claims the sessionId in layer 1 wins;
otherwise fall back to the tty match; otherwise the template; otherwise the row still
renders with a copyable `claude --resume <id>` and no focus affordance.

---

## 6. PR status model

**One badge is not enough.** Approval and unresolved discussion are independent axes, and
live data confirms the trap — these are real open PRs right now:

```
PR     state  reviewDecision      CI        threads(unresolved/total)
#2503  OPEN   APPROVED            SUCCESS   8/8      ← "approved, green" but 8 open threads
#2538  OPEN   REVIEW_REQUIRED     SUCCESS   17/23
#2453  OPEN   REVIEW_REQUIRED     SUCCESS   26/27
#2545  OPEN   REVIEW_REQUIRED     FAILURE   3/3
```

So the model is a **primary status plus annotations**. The primary status answers "whose turn
is it"; annotations answer "what else is outstanding".

Primary status, first match wins:

| # | Status | Condition | Icon |
|---|---|---|---|
| 1 | Merged | `state: MERGED` | merge arrow |
| 2 | Closed | `state: CLOSED` | slashed circle |
| 3 | Draft | `isDraft` | half circle |
| 4 | CI failing | `statusCheckRollup: FAILURE / ERROR` | x-circle |
| 5 | CI running | `statusCheckRollup: PENDING` | spinner (animated) |
| 6 | Changes requested | `reviewDecision: CHANGES_REQUESTED` | comment-dots |
| 7 | Approved | `reviewDecision: APPROVED` | check |
| 8 | Waiting for review | `reviewDecision: REVIEW_REQUIRED` | eye |
| 9 | Unknown | fetch failed | dash |

Annotations, shown alongside and independent of the primary:

| Annotation | Condition | Rendering |
|---|---|---|
| `N unresolved` | count of `reviewThreads.nodes` where `!isResolved` | count chip; muted when the primary is Merged or Closed |
| `N outdated` | `!isResolved && isOutdated` | folded into the tooltip only — these are usually stale nits, not blockers |

An approved PR with unresolved threads therefore reads **`✓ Approved · 8 unresolved`**, and
only a genuinely clear one reads `✓ Approved`. That distinction is the whole point: it is the
difference between "ready for takeoff" and "looks ready".

Rules: **colors come from semantic theme tokens, never hex.** Every status carries an icon and
a tooltip, so it never depends on color alone. `#2503` links to `prUrl`, opened in the system
browser via `shell.openExternal`.

Polling: 60s default, only for PRs attached to sessions currently in view, with ETag caching
and a manual refresh. Backs off on 403/rate-limit.

---

## 7. UI — four boards, ordered by the review pipeline

```
┌─ Control Tower ──────────────────────────────── ⟳ 12s ago   [theme ▾] ─┐
│  ◆ ON APPROACH (4)    ● EN ROUTE (16)    ▼ LANDED (10)    ✈ HOLDING    │
├────────────────────────────────────────────────────────────────────────┤
│ ●  7F93   Wire ChiliPiper onError through submit options     2m ago    │
│           SESSION  Control Tower session dashboard                     │
│           chat-sdk   sean/beacon-chilipiper-integration*               │
│           ⬤ #2538 APPROVED   ▲ 3 unresolved                            │
│                                                                        │
│ ○  4D5A   Hoist filterValueValidator out of the widget      41m ago    │
│           PR 2520  Move validation into the shared module              │
│           Extraction is done and tests pass; the v1 call site still    │
│           imports the old path and needs updating before review.       │
│           chat-sdk   cannuk/hoist-filter-validator                     │
│           ⬤ #2520 CI RUNNING                                           │
└────────────────────────────────────────────────────────────────────────┘
```

Boards are **stages of the review pipeline, not buckets of recency.** An earlier version split
on "active" versus "recent" and it did not survive contact: LANDED-by-recency filled with
sessions that had been interrupted and left sitting, which is the definition of a row you never
need to look at. What actually determines whether something needs you is where its pull request
is.

- **ON APPROACH** — a session holding an **unmerged PR with human review activity**. Covers both
  "changes requested, go fix it" and "approved but with follow-on comments I still want to read
  before merging". These are the rows waiting on *you*, so this board leads.
- **EN ROUTE** — a **running** session touched within `EN_ROUTE_WINDOW_HOURS` (8), holding no
  human-reviewed open PR. Work in flight, with or without a PR yet. The only board that answers
  "what is happening here", so the only one that carries a generated state summary (§8).
- **LANDED** — the last `LANDED_LIMIT` (10) merged PRs, as a shipping log. A fixed count rather
  than a time window: "the last ten things I shipped" stays a useful list through both a quiet
  week and a busy one, where "the last 72 hours" is either empty or overflowing.
- **HOLDING SHORT** — the staging area. Things queued for a session that does not exist yet.

Five rules make the split behave. Every one of them exists because the board showed a row that
should not have been there:

1. **Precedence: APPROACH, then LANDED, then EN ROUTE.** A session can hold several PRs, and one
   somebody is waiting on must not be buried by a sibling that merged.
2. **Nothing with an open PR reaches LANDED.** Not even alongside a merge — one merged sibling
   must not file a whole session under "shipped". Caught on live data: a session with two merged
   PRs and one open-but-unreviewed #2534 was sitting in LANDED.
3. **Neither bots nor you are reviewers.** CodeRabbit comments on nearly every PR, so counting it
   would put everything on APPROACH immediately; detected structurally via
   `author { __typename }` returning `Bot`, never by matching login names. The PR's own author is
   excluded for the same reason one step further (§8): #2471 was on APPROACH purely because its
   author had commented on their own work.
4. **EN ROUTE requires the process to be alive.** Recency alone was the original rule, from when
   that board meant "what have you touched lately". It means *in flight* now, and a session you
   interrupted an hour ago is not that — it is the row already rejected from LANDED: left behind
   in case it gets resumed, nothing to act on from here. Deliberately not applied to APPROACH or
   LANDED, where a PR with feedback waiting needs you whether or not its terminal is still open.
5. **One row per pull request on the PR-defined boards.** APPROACH and LANDED are named after a
   PR, but the row unit is a session and a PR accumulates sessions — five PRs on a real board
   were linked from two or three each, so #2501 appeared twice with an identical title and an
   identical review paragraph. The representative is the most recently active session, which for
   #2501 keeps today's "address the feedback" over the ten-day-old build session. EN ROUTE is
   left alone: there the row *is* the session, and two sessions working toward one PR are
   genuinely two things happening.

Rules 4 and 5 both remove rows, so both report what they removed rather than quietly shrinking
the board — a bounded view that admits its bound is honest, one that just stops is lossy and you
cannot tell from looking.

Every strip carries **both** identities — session and PR — with the board deciding which leads.
APPROACH and LANDED exist because of a pull request, so the PR titles the row and the session
becomes the subtitle. EN ROUTE inverts it: the work is in flight, often with no PR at all, so the
session leads. Whichever is secondary is still shown, because it is how you recognise the row.

Rows are deliberately not dense. A flight progress strip is scanned at a glance, not read, so
fields align into columns (fixed-width squawk gutter, elapsed time flush right) and the strip is
given the height to breathe.

Clicking the headline **tunes** to the session — brings its terminal to the front, or resumes it
if no tab is live. Clicking a PR chip opens GitHub. Relative times tick client-side every 30s
with the absolute timestamp in the tooltip.

Later (not in v1): tray/menubar popover, command palette, per-workspace grouping.

---

## 8. Summaries — how Control Tower gets one without a provider

Two boards carry a state line, and they get it from opposite directions. The distinction is
worth stating first, because the reflex is to reach for a model on both:

- **APPROACH is composed, not generated.** Everything that decides whether the row needs you is
  already structured — the review decision, who posted it, how many threads are unresolved and
  whose they are. A model asked to restate that would be slower, spend usage, and be capable of
  being wrong about a number we already hold exactly. So `shared/describe.ts` assembles four
  clauses from the GraphQL response and nothing else: stance, CI when it contradicts the stance,
  threads broken down by author, and outdated threads. Same state always produces the same
  sentence.
- **EN ROUTE needs a model,** because "what is this session doing" exists only as prose inside a
  transcript. That is what the rest of this section is about.

Getting the APPROACH sentence right also fixed a board rule. Writing "who is waiting" forced the
query to select author logins, which made it obvious that **you are not a reviewer of your own
PR** — GitHub does not allow it, so every "review" of yours is a comment. #2471 was sitting on
APPROACH purely because its author had commented on their own work. Your own review threads are
excluded from `advisories` for the same reason: the number exists to say what other people are
waiting on you for. It is the CodeRabbit rule (§7) one step further.

For EN ROUTE: Claude Code stores no semantic summary (§2.3). cmux's titles come from its own
`hooks claude auto-name` LLM call, so relying on them means the summary column goes blank the
moment you switch terminals. **Control Tower generates its own.** Same layered shape as focus —
best available wins:

**Layer 1 — the provider's title, when there is one.** Free, already computed, no latency. cmux
gives it via `surface.list`. Used as-is when present and non-stale.

**Layer 2 — Control Tower's own summarising call.** The provider-agnostic mechanism, and the
reason the column never goes blank. It also fixes something Layer 1 cannot: a terminal's title is
written once and then drifts. cmux titled this project's own session "Check new day skill status"
while it was megabytes deep in building Control Tower — accurate for the first question asked,
useless as a description of the work.

One call returns **two** fields, because the prompt is already assembled and asking for both costs
~60 extra output tokens where a second call would double the count:

- a **title** of at most six words, and
- a **state** of one or two sentences on where the work actually stands.

Mechanics, all of which exist because a first cut got them wrong:

1. **Scoped to EN ROUTE** — ~16 sessions, not the ~106 on disk. EN ROUTE is the only board that
   asks "what is happening here", so it is the only one whose answer decays; APPROACH is named
   after its PR and LANDED after what shipped. The unscoped version spent ~60 calls working
   through history and reached 3 of the 16 rows actually displayed.
2. **Cached on transcript byte size, and nothing else.** Transcripts are append-only, so a
   byte-identical size means nothing has happened and there is provably nothing new to say — no
   threshold to tune, no staleness window, no clock. An earlier "50KB *and* 25% growth" rule was
   a spend control wearing a correctness costume.
3. **First summaries are not rate-limited; refreshes are.** Filling a board is a bounded one-off
   (~16 calls, single-digit thousands of tokens) and until it finishes the row shows a visible
   gap, so it runs 5 per sweep until done. Refreshing is unbounded in principle — an active
   session genuinely has changed every minute — so it is capped at 3 behind a 5-minute floor,
   and only once nothing is waiting on a first summary. Putting both behind the floor is what
   made the board look broken rather than thrifty.
4. **Excerpted, not read whole.** The first user message plus the last few turns, from a file
   that can be 20MB. Both windows grow on miss: one assistant turn can exceed 64KB, so a fixed
   tail returned nothing for 5 of the 6 largest sessions. Tool output, hook output and IDE
   notices are filtered out — otherwise a bash stdout block reads as the user speaking.
5. **Sorted oldest-summary-first** on refresh. Every EN ROUTE session is usually "changed", so
   taking them in list order would spend every slot on the same busiest sessions forever.

No Claude Code hook is involved. Installing one would mean mutating your `settings.json`,
colliding with cmux's own `Stop` hook, and only working for Claude Code — watching the file
avoids all three and works for any terminal.

**Layer 3 — heuristic, no LLM.** First user message, stripped of `<ide_opened_file>` /
`<command-name>` wrappers, truncated. Free and instant; the fallback when no credential is
configured, and what fills the Recent tab's long tail rather than paying to title hundreds of
dead sessions.

### Auth and model — two backends, because a key is not always mintable

**Preferred: the Anthropic SDK with profile-based credentials.** `ant auth login` stores a profile
under `~/.config/anthropic/`, and a bare `new Anthropic()` picks it up with no env var — so **no
key ever enters this repo or the app bundle**, which matters given the repo is public. ~1s per
call, no transcript written, spends an API budget.

**Fallback, and the default in practice: headless Claude Code (`claude -p`).** Originally rejected
here as too heavy — it spawns a whole process per call and bills the Claude subscription — and
reinstated for the one reason that outranks that: **API keys cannot be minted in this org.** A
backend nobody can turn on is worth less than a slow one that works everywhere Claude Code is
already installed. `backend()` resolves per call rather than at startup, so a credential appearing
while the app runs is picked up without a restart.

Two things the headless backend needs to be a good neighbour:

- **Isolated.** Spawned with empty `--settings` hooks, `--strict-mcp-config` and an empty
  `--mcp-config` from a dedicated scratch cwd, so it cannot fire cmux's hooks, load MCP servers,
  or appear as a session in Control Tower's own board. Its project directory is excluded from the
  transcript scan by name.
- **Self-cleaning.** Each call leaves a transcript behind, pruned after every batch — and the
  prune verifies each file's recorded `cwd` before deleting. The path-mangling rule matters here:
  Claude replaces **every** non-alphanumeric character, not just `/` and `_`, so a hand-built
  path silently matched nothing and pruned nothing.

**Model: `claude-haiku-4-5`** for the headless backend, `claude-opus-5` at `effort: 'low'` for
the SDK one. Cost is not the deciding factor — measured median is ~264 input tokens per call, so a
full board is single-digit thousands of tokens — latency is. The SDK backend constrains output
with a JSON schema; the headless one has no structured output, so it asks for labelled `TITLE:` /
`STATE:` lines and validates the parse, rejecting titles over 70 characters or 10 words.

---

## 9. Milestones

**M0 — Socket-auth spike. ✅ RESOLVED — the socket is open to any process running as you.**

The concern was that `cmux capabilities` reports `"access_mode": "cmuxOnly"` and every probe
had run from a terminal *inside* cmux, which turns out to inject a per-surface capability
token into the environment (`CMUX_SOCKET_CAPABILITY=v1.<…>.<…>`, alongside
`CMUX_SOCKET_PATH=~/.local/state/cmux/cmux.sock`). If that token were the gate, an outside
Electron app would have been locked out.

It isn't. Verified with a fully scrubbed environment — `env -i HOME=… PATH=/usr/bin:/bin` —
that **both** paths work with no token, no password, and no `CMUX_SOCKET_PATH`:

- `cmux ping` → `PONG` (the CLI finds the default socket path itself)
- `cmux rpc surface.list '{"allWorkspaces":true}'` → full surface list
- `cmux rpc surface.focus '{"surface_id":"…"}'` → succeeded, returning the surface, pane,
  window and workspace refs (tested against the already-focused surface, so visually a no-op)

`access_mode: "cmuxOnly"` reports the same value from outside, so it does not describe caller
trust. **The actual security boundary is filesystem permissions**: the socket is
`srw-------`, owner-only. Any process running as this user has complete control of cmux.

Consequences: Control Tower talks to the cmux API directly, with no credential to store and
no fallback to scraping its session JSON. The `--password` / `CMUX_SOCKET_PASSWORD` path is
for remote or multi-user access, not for us. Worth stating the flip side plainly, though —
this is a permissive local surface, and anything running as you can drive your terminal.

**M1 — Skeleton. ✅ DONE.** electron-vite + React 19 + Tailwind 4 + shadcn/ui. Build the §3 token layer
*first* — semantic custom properties, two palettes to prove the swap, contrast-checked — then
the theme switcher with a persisted choice, custom titlebar, window geometry, and
eslint/prettier/husky. Ships as a window rendering a hardcoded session list at real density.
The remaining palettes land in M7; two are enough to prove the mechanism, and building the
token layer before any component stops hardcoded colors creeping in.

**M2 — Collectors, store, and live updates. ✅ DONE** (first sweep: 108 transcripts, 395MB, 57 PR links across 37 sessions). Registry reader with `startedAt`-based liveness;
transcript indexer with incremental byte-offset tail parsing backed by the §4 SQLite cache;
`chokidar` watchers on `~/.claude/sessions/`, `~/.claude/projects/**/*.jsonl`, debounced 500ms;
typed IPC pushing a `SessionSnapshot[]` to the renderer. Active list renders live with the
Layer-1/Layer-3 summary, relative time, and status dot.

**M3 — GitHub layer. ✅ DONE.** One `gh api graphql` query for all repos, status model from
§6, chips with icons and external links, permanent caching of settled PRs, 60s poll. No ETag
layer — see §2.4.

**M4 — Recent tab.** The recency split from §7: a configurable active-window threshold, plus
everything below it — long-idle live sessions and exited ones alike — from the transcript
scan, with titles for exited sessions from cmux's closed-item history. Capped and paginated.

**M5 — Provider abstraction.** The interface from §5, the cmux adapter (layer 1), the tty
matcher (layer 2), and the config template (layer 3). Click-to-focus works. At least one
non-cmux adapter — probably WezTerm or tmux — to prove the abstraction isn't cmux-shaped.

**M6 — Own titling (§8 Layer 2).** The provider-agnostic summary: debounced transcript excerpt
→ one schema-constrained titling call → cached by `(sessionId, messageCount)`. Falls back to
Layer 3 when no credential is configured. Deliberately after M5, so the abstraction is proven
before the app starts paying for titles — and so the non-cmux adapter has a summary to show.

**M7 — Settings and polish.** Provider selection/override, poll interval, which repos to
query, titling model and on/off, launch-at-login, packaged DMG.

**M8 — Ready for Takeoff** (the next feature, scoped separately). A queue of work not yet
started, persisted in SQLite (§4); "launch" creates the workspace and starts the session. cmux
supports this directly — `cmux new-workspace --name … --cwd … --command …` — which is why
`launch?()` is on the provider interface from the start. The §6 annotations matter most here:
a PR that is approved with 8 unresolved threads is not ready to land, and this queue is where
that distinction becomes actionable.

---

## 10. Repo conventions

- `github.com/cannuk/control-tower`, public.
- Plain commit messages, no conventional-commit prefixes.
- PR body: `## What` / `## Why` / `## Testing` only.
- Node via the Homebrew path (`/opt/homebrew/Cellar/node/23.11.0/bin`).

---

## 11. Decisions and remaining questions

Settled:

- **Public repo** at `github.com/cannuk/control-tower`. Since the code will be public, keep
  machine-specific paths out of it — everything under `~/.claude` and the cmux store is resolved
  at runtime from `os.homedir()`, never committed as a literal.
- **Boards are pipeline stages, not recency buckets** — see §7. Only EN ROUTE takes a recency
  bound (8h); APPROACH and LANDED are defined by PR state, which stays meaningful however long
  ago you last typed.
- **Neither bots nor the PR author are reviewers**, so CodeRabbit cannot promote a PR to APPROACH
  and neither can commenting on your own work — see §7 rule 3.
- **Nothing with an open PR appears in LANDED** — see §7 rule 2.
- **EN ROUTE requires a live process**, not just recent activity — see §7 rule 4. This reverses
  the original "recency, not liveness" call, which was made when that board meant "touched
  lately" rather than "in flight".
- **PR-defined boards show one row per PR**, represented by the most recently active session —
  see §7 rule 5.
- **APPROACH's state line is composed from review data, not generated** — see §8. The only place
  a model is used is EN ROUTE, where the answer exists solely as prose in a transcript.
- **A window now**, tray/menubar popover deferred to a later milestone.
- **SQLite via `node:sqlite`**, scoped to four non-derived things — see §4. `better-sqlite3` was
  the plan until `DatabaseSync` turned out to ship in the bundled Node 24, which removes the
  native module and `electron-rebuild` from the build entirely.
- **PR state is primary status + annotations**, not one badge — see §6. Confirmed against live
  data: #2503 is approved and green with 8 unresolved threads.
- **Control Tower generates its own summaries**, title and state in one call, scoped to EN ROUTE
  — see §8. Provider titles are a fast path, not the mechanism.
- **Two titling backends, headless Claude Code being the default** — see §8. Not the original
  plan; API keys are not mintable in this org, and a backend nobody can enable is worth less than
  a slow one that works.
- **One batched GraphQL query covering every repo**, aliased per repo rather than one call each.
  Measured at ~1 point plus roughly 1 per PR against a 5000/hr budget, so no allowlist is needed.
- **shadcn/ui + Radix, not daisyUI** — see §3. A one-way door, taken deliberately: themes become
  our own semantic CSS-variable sets in exchange for full control of component behavior and
  dashboard density.

Open:

1. **What counts as "last interaction"?** Currently transcript mtime, which ticks on any write
   including tool results, so a long autonomous run keeps a session looking fresh without you
   touching it. The alternative is the last *user* message in the transcript. Mtime is cheaper
   and probably what you want for "is this thing moving", but worth revisiting now that EN ROUTE
   membership depends on it.
2. **`unread` is always false.** The strip already has a cocked-strip treatment for it and cmux
   tracks `hasUnreadIndicator` in its store; wiring it up is unstarted.
3. **Renderer bundle is ~695KB** for what is a dozen icons and a handful of Radix primitives.
   `lucide-react`'s barrel import is not tree-shaking.
