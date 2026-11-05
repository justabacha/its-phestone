# Phase 1 — Feature Inventory

> **Status:** LOCKED (Phase 1 complete)
> **Last updated:** 2026-10-31
> **Owner:** Phestone
> **Purpose:** Define what the bot does, which commands exist, and which commands anchor the framework build.

---

## 1. Overview

This document inventories every command the rebuilt bot will support, categorizes them, selects six **anchor commands** that will be specified in detail (and used as test cases for the framework), and records all Phase 1 decisions.

**Scope of this phase:** *Inventory and pattern extraction only.* We do **not** spec every command in detail here. Individual command specs are written during the build phase, one at a time, as prompts to the IDE agent.

**Anchor principle:** the six anchor commands are chosen because each one exercises a structurally distinct part of the framework. Together they cover:
- The command registry / help system
- Status auto-view and reaction
- Status media saving (broadcast)
- View-once media saving (chat)
- Anti-delete monitoring (global toggle)
- AI auto-reply per chat (array-in-global-key toggle)
- Direct AI invocation with media input

If the framework can serve these six commands cleanly, the other eight are variations.

---

## 2. Command Inventory (14 commands)

All 14 commands are retained. Build order is decided during execution, not here.

| # | Command | Description | Category | Status |
|---|---|---|---|---|
| 1 | `help` | Show all available commands, grouped by category | Framework | **Anchor** |
| 2 | `autoview` | Configure auto status view and auto-reaction (mode + emoji list) | Status automation | **Anchor** |
| 3 | `vs` | Save a replied-to status (text or media) to owner's inbox | Status automation | **Anchor** |
| 4 | `antidelete` | Toggle anti-delete monitoring (all / group / private / off) | Message safety | **Anchor** |
| 5 | `autopilot` | Toggle AI auto-reply per chat when owner is away | AI / presence | **Anchor** |
| 6 | `phesty` | Ask the AI a question, or analyze a replied-to image | AI / presence | **Anchor** |
| 7 | `alive` | Bot status, uptime, telemetry, unread count, version check | System / diagnostics | Merged with `vault` |
| 8 | `vault` | System telemetry and bot status | System / diagnostics | **Merged into `alive`** |
| 9 | `sick` | Stealth-save a replied-to view-once media to owner's inbox | Message safety | Deferred |
| 10 | `ping` | Check bot response latency | System / diagnostics | Deferred |
| 11 | `restart` | Restart the bot process (owner only) | Ops / lifecycle | Deferred — see §6 |
| 12 | `update` | Pull latest code from GitHub and restart | Ops / lifecycle | Deferred — see §6 |
| 13 | `transcribe` | Transcribe a replied-to voice note (`!transcribe [en\|sw]`) | Media processing | Deferred |
| 14 | `find` | Identify a song from a replied-to audio/video | Media processing | Deferred |

### Command categories (reference)

| Category | Commands | Notes |
|---|---|---|
| Framework | `help` | Reads the command registry itself |
| Status automation | `autoview`, `vs` | `status@broadcast` handling |
| Message safety | `antidelete`, `sick` | Monitoring + forwarding |
| AI / presence | `autopilot`, `phesty` | Per-chat state + direct invocation |
| System / diagnostics | `alive` (merged), `ping` | Read-only info |
| Ops / lifecycle | `restart`, `update` | Process control |
| Media processing | `transcribe`, `find` | Heavy pipeline (ffmpeg / external API) |

---

## 3. Anchor Commands — Detailed Scope

Six anchors. Each one is specced with "done means…" acceptance criteria — observable behavior only, no implementation.

### 3.1 `help` — Framework anchor

**Why anchor:** the only command that reads the command registry. Its correctness proves the command loader and metadata contract work.

**Aliases:** `menu`, `commands`

**Done means:**
- `!help` (no args) → returns all commands, grouped by category, with one-line description each
- `!help <command>` → returns detailed usage for that command (aliases, args, permission, examples)
- `!help <unknown>` → returns a clean "no such command" reply, does **not** throw
- Only commands the sender is *permitted* to see are listed (owner sees everything; group members see public commands)
- Reply is readable on mobile — bounded length, sensible grouping

**Deferred:** paginated help for >30 commands. Not needed at 14.

---

### 3.2 `autoview` — Status auto-view anchor

**Why anchor:** the only command that touches `status@broadcast`. Exercises settings persistence, boolean toggles, emoji-list storage, and an event listener that runs *without* being invoked (the autoview behavior is passive).

**Done means:**
- `!autoview` (no args) → shows current state (enabled/disabled, emoji list)
- `!autoview on` → enables auto-view
- `!autoview off` → disables auto-view
- `!autoview emojis <list>` → replaces emoji list (e.g. `!autoview emojis 😂 ❤️ 🔥`)
- `!autoview react on|off` → toggles auto-reaction (separate from auto-view)
- Invalid arg → shows help, does **not** change state
- State persists across restart (via settings store)
- When enabled (`autoView=true`), incoming statuses are marked as read
- When react is enabled (`autoReact=true`), a random emoji from the configured list is sent as a reaction
- **Explicit keys:** `autoView` and `autoReact` are separate boolean toggles so viewing without reacting (or vice versa) is fully supported.
- **Edge case:** if the emoji list is empty and react is on, do **not** react — log and continue
- Errors are logged to the visible sink, never silently swallowed

**Open question (build-phase):** does the bot react to *all* statuses from all contacts, or only a whitelist? Default assumption: all contacts. Confirm before implementation.

---

### 3.3 `vs` — Status media save anchor

**Why anchor:** exercises quoted-message traversal, `downloadContentFromMessage`, and the "send to owner" helper — but **not** the same trigger as `sick` (broadcast vs view-once).

**Done means:**
- `!vs` used as a reply to a status → downloads the status media and sends it to owner's DM
- Works for both image and video statuses
- Works for text-only statuses → forwards the text verbatim to owner's DM
- If used without a reply → shows usage help, no download attempted
- If the replied message is **not** a status → replies with a clean error (not a crash)
- On download failure → logs error + sends an error message **only to owner**, never to the source chat
- Caption on saved media includes the original sender name/ID

**Distinction from `sick`:** `vs` targets `status@broadcast`; `sick` targets view-once media in a chat. Kept separate (confirmed by owner).

---

### 3.4 `antidelete` — Anti-delete anchor

**Why anchor:** canonical **global scalar toggle**. Exercises settings read/write, subcommand parsing, and mode persistence.

**Done means:**
- `!antidelete` (no args) → shows current mode + usage
- `!antidelete off` → disables monitoring
- `!antidelete all` → monitors all chats (private + group)
- `!antidelete group` → monitors groups only
- `!antidelete private` → monitors private chats only
- Invalid input → shows error, does **not** change mode
- Mode persists across restart
- When active and a message is deleted (revoke) → bot forwards the **original** content (text or media) to owner's DM with sender name, chat type, and timestamp
- **Implementation note for build:** Baileys delivers deletion as a `protocolMessage` with `type = REVOKE` and only the message **key** — not the content. The bot must **cache recent messages per monitored chat** (rolling window, in-memory + optional Mongo) to recover what was deleted. This is a real design task, not a one-liner.
- If the deleted message is **not** in cache → send owner a "deleted message detected but content unavailable" notice (do not crash)
- Errors logged to visible sink

---

### 3.5 `autopilot` — Per-chat AI toggle anchor

**Why anchor:** canonical **array-in-global-key toggle**. Exercises the second settings shape (array of chat IDs) and the "away timer" side of the FRIDAY integration.

**Done means:**
- `!autopilot` → toggles autopilot for the **current chat** on/off, replies with confirmation
- Confirmation clearly states current status (on/off) and the configured debounce timer
- State persists across restart
- Multiple chats can be on simultaneously (stored as an array under `autopilot` key)
- When on, the reply behavior follows the FRIDAY contract (§02-friday-contract.md): debounce timer → typing presence → contextual reply → exchange counter
- When the exchange counter hits the cap (default 10), bot goes silent for that chat and sends **one** escalation DM to owner
- Owner sending **any** message in a chat resets that chat's exchange counter and cancels any pending timer
- **Security:** only the owner can toggle — enforced at router level, but command also fails gracefully if somehow reached

**Deferred:** group support. Old bot was private-only; default is private-only unless owner changes it.

---

### 3.6 `phesty` — AI invocation anchor

**Why anchor:** the only command that does direct AI invocation with optional media input. The most complex single-command flow.

**Done means:**
- `!phesty <question>` → sends the question to FRIDAY's `/invoke` endpoint and replies with the answer
- `!phesty` as a **reply to an image** → downloads the image, uploads to Supabase Storage, sends to FRIDAY with the question text (or a default prompt if no text)
- `!phesty` as a **reply to text** → treats the quoted text as context plus the user's question
- Empty message + no media → shows usage help
- When FRIDAY is slow → shows a "thinking" indicator (presence `composing`) so the user knows it's working
- On FRIDAY error (timeout, 5xx, malformed JSON) → sends a clean "AI is unavailable, try again" message. Never leaks stack traces or internal URLs to WhatsApp
- **Media cleanup:** uploaded media is deleted from Supabase Storage after FRIDAY processes it (or by TTL)
- **Security & Visibility:** Only the owner can invoke `!phesty` (router-level check), but if invoked inside a group chat, the response is sent directly to that group (group-visible output).

**Deferred:** multi-image input. Single image per invocation.

---

## 4. Settings Model

**Confirmed shape:** flat global key-value store. No per-user, no per-group, no nested objects at the top level.

| Key | Type | Default | Used by | Notes |
|---|---|---|---|---|
| `antidelete` | string | `"off"` | `antidelete` | `"all" \| "group" \| "private" \| "off"` |
| `autopilot` | string[] (chat IDs) | `[]` | `autopilot` | Array-in-global-key — chat is "on" if its ID is present |
| `autoReact` | boolean | `false` | `autoview` | Toggle for status auto-reaction |
| `reactEmojis` | string[] | `["😂","❤️","🔥"]` (default TBD) | `autoview` | Emoji pool for status reactions |
| `autoView` | boolean | `false` | `autoview` | Toggle for auto status view (added in Phase 1 — was implicit before) |

**Notes:**
- `autoView` is a new explicit key. Old bot may have inferred "enabled" from `autoReact`; we separate them for clarity.
- The settings module must validate writes (reject invalid values, never silently write garbage). This is a Phase 3 decision.
- **Future-proofing flag:** a flat model breaks down if per-chat AI personas or per-group config are ever needed. Accepted trade-off for now; migrate to Mongo collections if needed.

---

## 5. Non-Command Features (implicit but real)

These are behaviors that aren't triggered by a command prefix but are part of the bot's functionality. They must be specced during build:

| Feature | Trigger | Notes |
|---|---|---|
| **Autoview** | Incoming `status@broadcast` | Runs if `autoView=true`; no command needed |
| **Auto-react to status** | Incoming `status@broadcast` | Runs if `autoReact=true` and emoji list non-empty |
| **Anti-delete monitoring** | `messages.update` with `protocolMessage: REVOKE` | Requires message cache (see 3.4) |
| **Autopilot reply** | Incoming message in an autopilot-enabled chat while owner is away | Per FRIDAY contract |

These are **first-class features**, not side effects. The framework must give them a clean home (an "event handler" layer separate from the command router).

---

## 6. Deferred Commands — Notes for Build Phase

Each of these is **retained on the master list** but not anchored. Decisions recorded here are for build-phase resolution, not Phase 1.

### `sick` (view-once save)
- **Retained separately** from `vs` (owner confirmed they are different).
- Old file was named `sick .js` (**with a space**) — this broke the old loader. New file will be `sick.js`.
- Old command silently failed when no quoted view-once found. New behavior: reply with short usage hint (not silence) — **to be confirmed during build**.

### `ping`
- **Retained.** Simple latency check. Will be a good first build-phase command because it's trivial — useful as a "framework works" smoke test.
- Other AI claimed it used a non-existent `edit` option. **Unverified** — will check during build. Doesn't block anything.

### `restart`
- **Retained.** Owner-only.
- On the new VPS + PM2 setup, `restart` should call `process.exit(1)` and let PM2 relaunch — **not** `exec` a shell command (safer, no shell injection surface).
- Confirm during build.

### `update`
- **Retained but flagged.** In the new GitHub Actions world, code deploys on `git push` → the command may become redundant.
- **Build-phase decision:** either drop `update` entirely, or rebrand it as "trigger redeploy via GH Actions API". Do **not** keep the old `git pull + restart` shell-exec pattern — it bypasses the deploy pipeline and creates two sources of truth.
- Owner will decide during build.

### `transcribe`
- **Retained.** Old filename was `transcibe.js` (typo). New file will be `transcribe.js`.
- Groq audio transcription, language flag (`en` / `sw`).
- Build-phase: confirm which provider (Groq Whisper vs other).

### `find` (song ID)
- **Retained.** Heavy pipeline: reply media → ffmpeg extract → external API → cleanup.
- Build-phase: confirm provider (ACRCloud, Shazam API, etc.) and licensing.

### `alive` + `vault` (merged)
- **Merged into a single `alive` command.** Owner confirmed they overlap. The merged command will present: uptime, version, unread count, package-outdated count (if cheap to check), and any telemetry `vault` had.
- Build-phase: decide final field list. Old `alive` used `exec('npm outdated')` on every call — this is slow on a VPS. New version should cache the result (e.g. re-check every 6h) or drop the field.

---

## 7. Security Model — Phase 1 Scope

**Strict owner-only rule.** Recorded here because it shapes every anchor:

- **Router-level enforcement:** the message handler rejects **any** command from a non-owner **before** the command file is loaded. Commands should never need to check ownership themselves.
- **`isOwner` definition:** `m.key.fromMe === true` **OR** sender's number is in `config.ownerNumbers[]`. Nothing else — not group admins, not a whitelist of "trusted" users, not anyone else.
- **Groups:** even in groups, commands only execute if `isOwner` is true. (This replaces the old bot's open-group behavior, which was a security hole.)
- **Non-owners in groups:** the bot ignores them. It does not reply "you're not permitted" — silent is safer (no signal that a bot is present).

This is a **Phase 3 formalization** item; the principle is locked here.

---

## 8. Decisions Log (Phase 1)

| # | Decision | Rationale | Date |
|---|---|---|---|
| D1 | All 14 commands retained; build order decided during execution | Owner workflow: audit → plan → execute, per feature | 2026-10-31 |
| D2 | Six anchors locked: `help`, `autoview`, `vs`, `antidelete`, `autopilot`, `phesty` | Each exercises a structurally distinct framework part | 2026-10-31 |
| D3 | `sick` and `vs` kept **separate** | Different triggers (view-once in chat vs status broadcast) | 2026-10-31 |
| D4 | `alive` and `vault` **merged** into one command | Owner confirmed overlap; merge produces stronger command | 2026-10-31 |
| D5 | Settings model is flat global key-value | Matches old bot's consumption pattern; simple | 2026-10-31 |
| D6 | New explicit key `autoView` (was implicit) | Separation of concerns from `autoReact` | 2026-10-31 |
| D7 | Strict owner-only rule, enforced at router level | Old bot allowed group members to run commands — security hole | 2026-10-31 |
| D8 | Old file name typos (`sick .js`, `transcibe.js`) noted; new files use correct names | Cleanliness + loader correctness | 2026-10-31 |
| D9 | `update` command flagged for build-phase reconsideration | GH Actions may make it redundant | 2026-10-31 |
| D10 | Anti-delete requires per-chat message cache (design task, not one-liner) | Baileys revoke delivers key only, not content | 2026-10-31 |

---

## 9. Open Items Carried to Later Phases

| Item | Carried to | Notes |
|---|---|---|
| Settings validation schema | Phase 3 | Reject invalid writes |
| Error sink location & format | Phase 3 | "Silent to users, loud to owner" |
| Cooldown / anti-spam defaults | Phase 3 | Per-command, per-chat, per-user |
| Presence helper (`composing` / `paused`) | Phase 3 | Reused by `autopilot` and `phesty` |
| Media download helper | Phase 3 | Reused by `vs`, `sick`, `phesty`, `transcribe`, `find` |
| "Send to owner DM" helper | Phase 3 | Reused by `vs`, `sick`, `antidelete` |
| `alive` final field list | Build phase | Decide on `npm outdated` caching |
| `transcribe` provider | Build phase | Groq Whisper vs other |
| `find` provider | Build phase | ACRCloud / Shazam / etc |
| `autoview` react scope (all contacts vs whitelist) | Build phase | Default assumption: all |
| `sick` no-quoted behavior (silent vs usage hint) | Build phase | Old: silent |

---

## 10. Definition of Done for Phase 1

- [x] All commands inventoried
- [x] Categories assigned
- [x] Anchors selected and justified
- [x] Acceptance criteria written for all six anchors
- [x] Settings model recorded
- [x] Non-command features recorded
- [x] Deferred commands annotated
- [x] Security model recorded (high level)
- [x] Decisions log recorded
- [x] Open items carried forward to Phase 3 / build

**Phase 1 status: COMPLETE.**

---

*Next: `02-friday-contract.md` (Phase 2).*