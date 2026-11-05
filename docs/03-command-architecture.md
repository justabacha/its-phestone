# Phase 3 — Command Architecture

> **Status:** LOCKED (Phase 3 complete)
> **Last updated:** 2026-10-31
> **Owner:** Phestone
> **Purpose:** Define the internal architecture of the bot — directory structure, command file contract, router flow, settings module with validation, error policy, helper library, event handlers, message store, cooldowns, and connection logic.

---

## 1. Overview

This document is the **implementation contract**. Every file the IDE agent writes must conform to it. If the agent deviates — or if we later change the spec — the doc is updated first, then the code.

**Governing principles:**
- **Router enforces security, not commands.** Owner gate lives in one place. A command file cannot leak permission.
- **Errors are silent to users, loud to owner.** Every failure path has a destination in the log sink. No bare `try {} catch {}` anywhere.
- **Helpers are imported, not reimplemented.** A command file should be ~30 lines of business logic + a call to a helper.
- **Message store is first-class infrastructure.** It's used by Baileys (decryption fallback), antidelete (recovery), and autopilot (history). It is *not* an afterthought.

---

## 2. Directory Structure

```
index.js                          ← entry: sets up logger, starts app
config.js                         ← env-loaded config (prefix, owners, tuning)
core/
  connection.js                   ← socket creation, auth, reconnect logic
  router.js                       ← command routing + owner gate + cooldown
  registry.js                     ← scans commands/ once at startup, builds Map
  settings.js                     ← validated read/write settings, persistent
  errors.js                       ← error sink (log + rate-limited owner DM)
  cache/
    messages.js                   ← message store (getMessage, getRecent, put)
  events/
    autoview.js                   ← status@broadcast handler (passive)
    antidelete.js                 ← REVOKE handler (passive)
    autopilot.js                  ← per-chat state machine (passive)
lib/
  reply.js                        ← reply helpers (text, media)
  owner.js                        ← notify-owner helpers
  media.js                        ← download from WA, upload to Supabase Storage
  presence.js                     ← composing / paused / typingForLength
  friday.js                       ← FRIDAY client (invoke, replyDecision)
  logger.js                       ← pino wrapper (structured JSON)
commands/
  *.js                            ← one file per command (14 total)
session/                          ← ⚠️ legacy — Mongo replaces disk auth. Kept only for first-run migration if needed.
```

**Why this layout:**
- `core/` is infrastructure the bot cannot run without.
- `lib/` is reusable helpers that commands and event handlers call.
- `commands/` is business logic — one file per command, nothing else.
- `events/` is passive behaviors that trigger on Baileys events, not commands.

**Rule:** command files may import from `lib/` and `core/settings.js`. They may **not** import from `core/connection.js` (no socket access — the socket comes via `ctx`), or from other commands (no cross-command calls).

---

## 3. Command File Contract

Every file in `commands/` must export exactly this shape:

```js
module.exports = {
  // Required
  name: 'antidelete',                // must match filename minus .js
  async run(ctx) { /* ... */ },

  // Optional
  aliases: ['ad'],                    // alternate names
  description: 'Toggle anti-delete monitoring',
  category: 'message-safety',        // for help grouping
  permission: 'owner',               // 'owner' | 'everyone'  (default: owner)
  cooldown: 3000,                    // ms override (default: 2000)
  usage: '!antidelete [all|group|private|off]',
  examples: ['!antidelete all', '!antidelete off'],
};
```

### The `ctx` object

`run(ctx)` receives one argument with everything the command needs. Commands **do not** receive raw `sock` and `msg` separately — that's a legacy pattern we're dropping.

```js
ctx = {
  // Identity
  sock,           // Baileys socket (read-only usage — sending, downloading)
  msg,            // raw Baileys message
  chatId,         // string — remoteJid
  sender,         // string — participant JID (or chatId for DMs)
  isGroup,        // boolean
  isOwner,        // boolean — always true here (router enforces), kept for clarity

  // Parsed input
  args,           // string[] — whitespace-split args after command name
  rawText,        // string — full body after prefix
  commandName,    // string — invoked name (may be an alias)

  // Helpers (bound to this ctx)
  reply: (text, opts) => Promise,                  // send text to chatId, quoted
  replyMedia: (type, buffer, opts) => Promise,     // send media to chatId, quoted
  notifyOwner: (text, opts) => Promise,            // DM to owner (first in list)
  downloadQuoted: () => Promise<{buffer, type, mime} | null>,
  uploadToStorage: (buffer, mime) => Promise<string>, // returns storage_path
}
```

**Why helpers on `ctx` and not just imported:**
Commands import `lib/` for logic that's stateless. Helpers that need `chatId`/`msg` context are bound to `ctx` to prevent mistakes (e.g., accidentally replying to the wrong chat). Both are valid — helpers on ctx are convenience; imported helpers are for reusable, context-free logic (e.g., `friday.invoke(payload)`).

### No auto-presence

Commands **must not** auto-send `composing`. If a command wants typing behavior, it calls `lib/presence.js` explicitly. Reason: `phesty` needs it; `antidelete` doesn't. Auto-presence would be robotic noise across all commands.

---

## 4. Router Flow

This is the flow every incoming message takes. Router lives in `core/router.js`; it is called from `index.js` on `messages.upsert`.

```
1.  messages.upsert fires (batch)
2.  For each m in batch:
3.    m.message exists?                        → no → skip
4.    type === 'notify'?                      → no → skip  (skip append/history)
5.    from === 'status@broadcast'?            → yes → skip (handled by events/autoview)
6.    Extract body (conversation || extendedTextMessage.text || imageMessage.caption)
7.    body starts with config.prefix?         → no → skip (autopilot handles non-commands separately)
8.    commandName = first token, lowercased
9.    Look up in registry (direct + aliases)  → miss → SILENT SKIP  (no "unknown command")
10.   Owner gate: isOwner?                    → no → SILENT SKIP
11.   Cooldown check                          → on cooldown → SILENT SKIP
12.   Build ctx
13.   try { await command.run(ctx) }
14.   catch (err) → errors.sink(err, { ctx, phase: 'command' })
```

### Key decisions in the router

| Decision | Rationale |
|---|---|
| **Silent skip on unknown command** | Anti-detection. A bot that replies "unknown command" is detectable. Also avoids noise if someone typo's the prefix. |
| **Silent skip on non-owner** | Phase 1 §7 confirmed. No "you're not permitted" reply. |
| **Silent skip on cooldown** | Phase 3 decision (§11). No "wait Xs" — that's chatty and detectable. |
| **`type === 'notify'` guard** | Prevents re-processing old/history messages on reconnect. |
| **`status@broadcast` diverted to events** | Status handling is passive, not command-driven. Router should not touch it. |
| **Errors caught at router level** | Last line of defense. If a command throws, router catches and sinks. No command should ever crash the process. |

**No `event` filter for group vs private** — commands decide what they do with `ctx.isGroup`. The router treats all chats equally (owner-gated).

### Router does NOT do these
- Show typing indicator (commands do, if they want)
- Reply with errors to users (errors go to owner sink only)
- Retry failed commands (no — if a command fails, log it; owner investigates)
- Route non-command messages (autopilot handles those separately in `events/`)

---

## 5. Command Registry

Lives in `core/registry.js`. **Built once at startup.** Never re-scanned per message (fixes old bot's `readdirSync` per-message bug).

### Loading algorithm
```
1. readdir commands/*.js
2. For each file:
   a. require(file)
   b. Validate: has `name`, has `run` function
   c. If name !== filename-minus-.js → log warning, skip (don't load)
   d. Store in Map keyed by name
   e. For each alias → also store in Map keyed by alias (pointing to same command)
3. On any require error → log, skip that file, continue (fail-safe)
4. Log summary: "Loaded N commands, M aliases"
```

**Why fail-safe:** one broken command file should not prevent the bot from starting. The old bot would have crashed on a `sick .js` style typo. New behavior: log the broken file, continue.

### Registry API
```js
registry.get(name)        // returns command object or undefined
registry.all()            // returns array of unique commands (deduped, aliases not listed)
registry.categories()     // returns Map<category, command[]>
```

Used by: router (lookup), `help` command (all/categories), potentially `alive` (command count).

---

## 6. Settings Module — Validated, Persistent

Lives in `core/settings.js`. Fixes the old bot's "silently write garbage" problem.

### Schema (source of truth)
```js
const SCHEMA = {
  antidelete:  { type: 'enum',   values: ['all', 'group', 'private', 'off'],  default: 'off' },
  autopilot:   { type: 'array',  of: 'string',  default: [] },
  autoView:    { type: 'boolean', default: false },
  autoReact:   { type: 'boolean', default: false },
  reactEmojis: { type: 'array',  of: 'string',  default: ['😂', '❤️', '🔥'] },
};
```

### API
```js
settings.get(key)         // returns value (from cache or default if unset)
settings.set(key, value)  // validates; throws on invalid, doesn't write
settings.getAll()         // returns frozen snapshot
settings.reload()         // forces disk read (rarely needed)
```

### Validation rules
- `key` must exist in SCHEMA → otherwise throw `SettingsError`
- `type: 'enum'` → value must be in `values`
- `type: 'boolean'` → value must be `true`/`false` (not `'true'` string — the old bot was stringy)
- `type: 'array'` → value must be array of `of` type; strings must be non-empty
- Type mismatch → throw `SettingsError` with clear message

**Commands calling `settings.set()` must catch `SettingsError`** and reply with usage — never let it bubble to router. (Router catches it anyway, but a command knows its own valid values and should reply meaningfully.)

### Persistence
- Storage: `settings.json` on VPS disk (same file the old bot used) — but **atomic writes**:
  ```
  write to settings.json.tmp
  fsync
  rename to settings.json
  ```
- Read on startup into memory. All reads served from memory.
- On `set()`: validate → update memory → atomic write → update cache.
- **No 5-second cache timeout** (old bot had this — it was a hack). Reads are in-memory; only writes touch disk.

**🟡 Future migration:** if settings need to be shared across multiple bot instances (multi-number), move to Mongo. Not needed now.

---

## 7. Error Policy — The Log Sink

Lives in `core/errors.js` + `lib/logger.js`.

### The rule (from Phase 2 §8, reinforced here)
> **Silent to users. Loud to owner.**

Every error goes through `errors.sink(err, context)`. Nothing is ever caught and swallowed without calling `sink`.

### Error categories & routing

| Category | Log (file) | DM owner | Example |
|---|---|---|---|
| **Command crash** | ✅ | ✅ (rate-limited) | `phesty` throws, `vs` throws |
| **FRIDAY auth failure (401)** | ✅ | ✅ (immediate) | Wrong secret |
| **FRIDAY repeated 5xx** (>3 in 5 min) | ✅ | ✅ (once per 5 min) | Groq outage |
| **Connection lost** (triggering restart) | ✅ | ✅ | Socket disconnect → exit → PM2 restart |
| **Message store cache miss** | ✅ | ❌ | Normal for old messages — just debug info |
| **Cooldown hit** | ❌ | ❌ | Expected behavior |
| **Non-owner tried command** | ❌ | ❌ | Ignored silently by design |
| **Settings validation rejected** | ✅ | ❌ | Debug info |

### Owner DM rate-limiting
- Max **1 DM per error category per 60 s**.
- Tracked in-memory: `Map<category, lastDmTs>`.
- If a category is rate-limited, the log still gets every occurrence.

### Log format
- Structured JSON via `pino` → stdout (captured by PM2)
- Each entry: `{ ts, level, category, msg, command?, chatId?, err? }`
- **🔴 Never log:** `FRIDAY_SHARED_SECRET`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `SUPABASE_SERVICE_KEY`, full message bodies of private chats. Log chat ID and error type only.
- Redaction: `pino.redact` configured for the secret paths.

### `logger` API
```js
logger.info(category, msg, meta)       // normal
logger.warn(category, msg, meta)       // noteworthy
logger.error(category, msg, meta)      // errors.sink calls this
logger.fatal(category, msg, meta)      // process about to exit
```

---

## 8. Helper Library — `lib/`

All helpers are pure modules. Imported by commands and event handlers.

### 8.1 `lib/reply.js`
```js
async function reply(ctx, text, opts = {})
  // sends text to ctx.chatId, quoted to ctx.msg
  // auto-splits text > 4000 chars (WhatsApp limit) into multiple sends
  // returns: { ok: true } or throws

async function replyMedia(ctx, type, buffer, opts = {})
  // type: 'image' | 'video' | 'audio' | 'document'
  // opts: { caption?, mimetype?, fileName? }
```
**Consistent shape:** every reply goes through this — no direct `sock.sendMessage` in commands.

### 8.2 `lib/owner.js`
```js
async function notifyOwner(text, opts = {})
  // sends text to first owner in config.ownerNumbers
  // uses same split-if-long behavior as reply
  // NEVER quotes (owner DM is standalone)

async function notifyOwnerMedia(type, buffer, opts = {})
```
Used by `vs`, `sick`, `antidelete`, and `errors.sink` (for critical errors).

### 8.3 `lib/media.js`
```js
async function downloadQuoted(msg)
  // extracts quoted media from msg.message.extendedTextMessage.contextInfo
  // returns { buffer, type, mime } or null
  // handles: imageMessage, videoMessage, audioMessage, documentMessage, stickerMessage

async function downloadFromStatus(statusMsg)
  // extracts media from a status@broadcast message
  // same return shape

async function uploadToStorage(buffer, mime)
  // uploads to Supabase Storage `friday-media` bucket
  // returns: storage_path (string)
  // throws on failure (caller decides how to handle)

async function deleteFromStorage(storagePath)
  // best-effort delete; doesn't throw
```
Internally uses `@whiskeysockets/baileys` `downloadContentFromMessage` + Supabase client.

### 8.4 `lib/presence.js`
```js
async function composing(sock, jid)        // send 'composing' presence
async function paused(sock, jid)           // send 'paused' presence
async function typingForText(sock, jid, text)
  // calls composing, sleeps for the formula in Phase 2 §6, returns
  // caller then sends reply, then calls paused
```
**Never auto-sent.** Only `phesty` and `events/autopilot.js` call these.

### 8.5 `lib/friday.js`
```js
async function invoke(payload)
  // POST /invoke — manual phesty flow
  // timeout: 15s (Phase 2 §8)
  // one retry on 5xx
  // returns: { action, text, conversation_id }
  // throws on: 401, timeout, malformed response (caller decides UX)

async function replyDecision(payload)
  // POST /reply — autopilot flow
  // same timeout/retry rules
  // returns: { action, text, conversation_id }
```
**Auth:** reads `FRIDAY_SHARED_SECRET` from env; adds `Authorization: Bearer` header.

### 8.6 `lib/logger.js`
Wraps `pino`. Configured for redaction (§7).

---

## 9. Event Handlers — `core/events/`

Passive features that react to Baileys events, not commands. Each file exports `register(sock, deps)` and sets up its own listeners.

### 9.1 `events/autoview.js`
```
register(sock):
  sock.ev.on('messages.upsert', handleStatus)
  where handleStatus:
    - from === 'status@broadcast'?
    - settings.get('autoView') === true?   → sock.readMessages([key])
    - settings.get('autoReact') === true?  → pick random emoji from reactEmojis
                                              → send reaction
    - if reactEmojis empty → log warning, skip react
```
**Does not go through router.** Router skips `status@broadcast` messages entirely.

### 9.2 `events/antidelete.js`
```
register(sock, { messageStore }):
  // Two responsibilities:
  // 1. Cache every non-status message (so it can be recovered on delete)
  //    -> sock.ev.on('messages.upsert', cacheMessage)
  // 2. Detect revokes
  //    -> sock.ev.on('messages.update', handleRevoke)
  //    -> if protocolMessage.type === 'REVOKE':
  //         original = messageStore.get(key)
  //         if original && modeMatches(original, settings.get('antidelete')):
  //             forward original to owner
  //         else:
  //             notifyOwner('deleted but content unavailable')
```

**Mode matching:**
- `'all'` → both private and group
- `'group'` → `chatId.endsWith('@g.us')`
- `'private'` → `!chatId.endsWith('@g.us')`
- `'off'` → no forwarding

### 9.3 `events/autopilot.js`
The most complex event handler. Implements the Phase 2 §5 state machine.

```
register(sock, { messageStore }):
  state per chat: Map<chatId, {
    state: 'IDLE' | 'WAITING' | 'THINKING' | 'TYPING',
    timer: NodeJS.Timeout | null,
    exchangeCount: number,
    sessionStartTs: number | null,      // for 4h cap
    inFlight: AbortController | null,
  }>

  sock.ev.on('messages.upsert', handleIncoming)
  where handleIncoming:
    - from === 'status@broadcast'? → skip
    - sender is owner?             → resetState(chatId); return
    - settings.get('autopilot').includes(chatId)? → skip
    - state === 'CAPPED'?          → skip
    - state === 'WAITING'?         → reset timer (debounce)
    - state === 'IDLE':
        - if sessionStartTs && (now - sessionStartTs) > 4h → skip (D28)
        - start session: sessionStartTs = now, exchangeCount = 0
        - arm timer with random(0.75×T, 0.875×T)
    - state === 'THINKING' or 'TYPING'? → skip (in-flight, don't reset)

  onTimerFires(chatId):
    - state = 'THINKING'
    - call friday.replyDecision({ history, last_message, exchange_index })
    - if action === 'ignore'    → state = 'IDLE'; return
    - if action === 'escalate'  → notifyOwner(...); state = 'IDLE'; return
    - if action === 'reply':
        - state = 'TYPING'
        - presence.composing(sock, chatId)
        - await presence.typingForText(sock, chatId, text)
        - reply(ctx, text)
        - presence.paused(sock, chatId)
        - exchangeCount++
        - if exchangeCount >= MAX_EXCHANGES:
            state = 'CAPPED'
            notifyOwner(`autopilot cap reached for ${chatId}`)
        - else state = 'IDLE'
```
**Edge cases:**
- Owner sends message during THINKING → abort in-flight (AbortController), state = IDLE
- FRIDAY timeout → state = IDLE (silent)
- Bot restart → all state lost; sessions restart clean (this is acceptable — restart is rare)

---

## 10. Message Store — `core/cache/messages.js`

Serves three consumers:
1. **Baileys `getMessage`** — decryption fallback
2. **`events/antidelete.js`** — retrieving deleted content
3. **`events/autopilot.js`** — reading history for FRIDAY requests

### API
```js
put(chatId, key, message)          // store a message
get(key)                           // retrieve by message key (from Baileys, antidelete)
getRecent(chatId, count = 20)      // get last N messages for a chat (autopilot)
```

### Storage
- In-memory only (MVP). LRU-evict chats beyond `MESSAGE_STORE_MAX_CHATS=200`.
- Per-chat retention: `MESSAGE_STORE_PER_CHAT=100` messages.
- Oldest dropped when full.

### `getMessage` integration with Baileys
```js
makeWASocket({
  ...
  getMessage: async (key) => {
    const msg = messageStore.get(key);
    if (!msg) {
      logger.warn('messages', 'getMessage cache miss', { key });
      return undefined;  // ← Baileys handles undefined gracefully
    }
    return msg.message;
  }
})
```
**Why not the old bot's fake fallback:** returning a fake `{ conversation: 'Engine V3 Recovery' }` masks real failures. Returning `undefined` lets Baileys know the message isn't available — it handles this case (skips/ignores the message) without crashing. A cache miss is logged but not fatal.

### Memory footprint
100 msgs × 200 chats × ~1KB/msg ≈ 20 MB. Trivial for a 6GB VPS. Not worried.

**🟡 Deferred:** Mongo write-through for persistence across restarts. In-memory is sufficient for MVP because:
- Baileys caches its own keys (decryption rarely needs our store)
- Antidelete only needs recent messages (deleted within last few minutes is the common case)
- Autopilot history resets on restart anyway (Phase 2 §4)

---

## 11. Cooldowns

Lives in `core/router.js` (per-command enforcement).

### Model
```
Map<`${sender}:${commandName}`, lastRunTs>
```

### Behavior
- Default: **2000 ms** per (sender, command) pair
- Override: `command.cooldown` in command file
- On hit → **silent skip** (router-level). Do not reply "wait Xs".

### Why 2s default
- Prevents accidental double-tap
- Prevents a runaway loop in a buggy command
- Owner-only bot doesn't need aggressive per-user limits

**Not enforced on passive events** (autoview, autodelete, autopilot) — they're not command-triggered.

---

## 12. Connection Logic — `core/connection.js`

Fixes the old bot's flat-5s-reconnect loop.

### Startup
```
1. Load Mongo auth state via useMongoAuthState(MONGODB_URI)
2. If no session → use pairing code (Phase 2 decision) — log instructions
3. Create socket with:
   - logger: pino (from lib/logger)
   - syncFullHistory: false
   - shouldSyncHistoryMessage: () => false
   - getMessage: bound to messageStore (see §10)
   - browser: ['its-phestone-v3', 'MacOS', '1.0.0']
4. Attach creds.update → saveCreds
5. Attach connection.update → handleReconnect
```

### Reconnect logic (exponential backoff)
```
attempt = 0
handleReconnect({ connection, lastDisconnect }):
  if connection === 'open':
    attempt = 0
    log 'connected'
    return

  if connection === 'close':
    statusCode = lastDisconnect?.error?.output?.statusCode
    if statusCode in [401, 411]:
      log fatal: 'session invalid — delete session, re-pair'
      await notifyOwner('Session invalid — bot offline. Re-pair required.')
      process.exit(1)         // PM2 restarts, but session is invalid
    else:
      attempt++
      delay = min(5000 * 2^(attempt-1), 60000) + random(0, 5000)
      log warn: `reconnect in ${delay}ms (attempt ${attempt})`
      setTimeout(() => startConnection(), delay)
```

**Why exponential backoff:** flat 5s loops cause rate-limit bans from WhatsApp when the server is down. Backoff spreads retries.

**PM2 as outer safety net:** if in-process reconnect somehow gets stuck (bug, deadlock), PM2's `max_restarts` with `min_uptime` eventually restarts the whole process. Two layers of resilience.

### Pairing code vs QR
- **MVP uses pairing code** (Phase 2 decision) — no terminal QR needed
- Flow: on first run (no session), bot prints pairing code to logs → owner enters it in WhatsApp → session saved to Mongo
- Subsequent runs: session found, no pairing

---

## 13. Config Module — `config.js`

Env-driven. Loaded once at startup, validated.

```js
module.exports = {
  prefix: process.env.PREFIX || '!',
  ownerNumbers: (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean),
  branding: process.env.BRANDING || '',         // default: empty (owner-only bot)
  
  autopilot: {
    timerMs: parseInt(process.env.AUTOPILOT_TIMER_MS) || 120000,
    maxExchanges: parseInt(process.env.AUTOPILOT_MAX_EXCHANGES) || 10,
    sessionCapMs: 4 * 60 * 60 * 1000,           // 4h, hardcoded per D28
  },
  
  friday: {
    contextWindow: parseInt(process.env.FRIDAY_CONTEXT_WINDOW) || 20,
    timeoutMs: 15000,
  },
  
  messageStore: {
    maxChats: 200,
    perChat: 100,
  },
};
```

**Startup validation:**
- `ownerNumbers.length > 0` → else throw fatal
- `prefix.length >= 1` → else throw
- Required env vars present (MONGODB_URI, SUPABASE_URL, FRIDAY_SHARED_SECRET, etc.) → else throw fatal with which one is missing

**Fail-fast on bad config** — better than running with broken config.

---

## 14. Decisions Log (Phase 3)

| # | Decision | Rationale | Date |
|---|---|---|---|
| D29 | Router enforces owner gate, not commands | Single point of security; commands can't leak | 2026-10-31 |
| D30 | Commands receive `ctx` object, not raw (sock, msg, args) | Cleaner, easier to test, no accidentally replying to wrong chat | 2026-10-31 |
| D31 | Registry built once at startup, fail-safe on bad command files | Fixes old bot's readdirSync-per-message + crash-on-typo | 2026-10-31 |
| D32 | Settings module validates on write, atomic file writes | Fixes old bot's silent-garbage-writes | 2026-10-31 |
| D33 | Error sink: log all + rate-limited owner DM for critical | Fixes silent-catch bugs; owner stays informed without noise | 2026-10-31 |
| D34 | Redaction in logger for secrets | Security hygiene | 2026-10-31 |
| D35 | Helpers on `ctx` (bound) for context-dependent; imported for stateless | Prevents chat-targeting mistakes | 2026-10-31 |
| D36 | Router silently skips unknown commands | Anti-detection | 2026-10-31 |
| D37 | Cooldown: 2s default per (sender, command), silent skip | Prevents double-fire, anti-detection | 2026-10-31 |
| D38 | Message store: in-memory, LRU, 100 msgs × 200 chats | Sufficient for MVP; ~20MB footprint | 2026-10-31 |
| D39 | `getMessage` returns `undefined` on miss, not a fake message | Old bot's fake-message fallback masked failures | 2026-10-31 |
| D40 | Exponential backoff reconnect (5s→60s), PM2 as outer net | Prevents rate-limit ban during outages | 2026-10-31 |
| D41 | Pairing code only, no QR in logs | Cleaner on headless VPS | 2026-10-31 |
| D42 | Config fail-fast validation at startup | Better to crash loudly than run broken | 2026-10-31 |
| D43 | Branding default empty | Owner-only bot doesn't need to advertise itself | 2026-10-31 |
| D44 | Passive features live in `core/events/`, not commands | Clean separation: commands trigger on prefix, events trigger on Baileys events | 2026-10-31 |
| D45 | No auto-presence in commands | Prevents robotic typing noise; only `phesty` and `autopilot` need it | 2026-10-31 |

---

## 15. Open Items Carried Forward

| Item | Carried to | Notes |
|---|---|---|
| PM2 ecosystem config file | Phase 4 | `max_restarts`, `min_uptime`, autorestart |
| GH Actions workflow file | Phase 4 | Deploy on push to main |
| Supabase Storage bucket + TTL job | Phase 4 | `friday-media`, 24h cleanup |
| Mongo auth state implementation (which lib) | Phase 4 / build | `useMongoAuthState` from community package — verify version |
| Service-key scoping (Storage-only) | Phase 4 | Security hygiene |
| FRIDAY system prompt / persona | Build phase | Voice, tone, escalation |
| `phesty` "thinking" indicator timing | Build phase | How long to show composing before reply |
| Per-command `usage` strings | Build phase | As each command is built |
| The 6 anchor "done means" verification | Build phase | Phase 1 §3 is the reference |

---

## 16. Definition of Done for Phase 3

- [x] Directory structure locked
- [x] Command file contract + `ctx` object fully defined
- [x] Router flow step-by-step, with silent-skip rules
- [x] Registry loading algorithm + fail-safe
- [x] Settings module schema + validation rules
- [x] Error policy (sink categories, rate-limiting, redaction)
- [x] Helper library APIs (`reply`, `owner`, `media`, `presence`, `friday`, `logger`)
- [x] Event handler layer defined (`autoview`, `antidelete`, `autopilot`)
- [x] Message store API + integration with Baileys `getMessage`
- [x] Cooldown model
- [x] Connection logic (backoff, PM2 outer net)
- [x] Config module shape + fail-fast validation
- [x] Decisions log (D29–D45)
- [x] Open items carried forward

**Phase 3 status: COMPLETE.**

---

*Next: `04-infra-runbook.md` (Phase 4).*