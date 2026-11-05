# Phase 2 — FRIDAY Integration Contract

> **Status:** LOCKED (Phase 2 complete)
> **Last updated:** 2026-10-31
> **Owner:** Phestone
> **Purpose:** Define the boundary between the Baileys bot (Oracle VPS) and FRIDAY (Supabase Edge Function) — request/response schemas, memory model, autopilot state machine, typing simulation, media handling, error policy, and LLM provider abstraction.

---

## 1. Architecture — The Boundary

```
WhatsApp ──► Baileys bot (Oracle VPS) ──HTTPS──► Supabase Edge Function (FRIDAY)
                    │                                       │
                    │                                       ▼
                    │                               LLM provider (Groq primary)
                    │                                       │
                    ▼                                       ▼
              Mongo (auth only)                  Supabase Storage (media)
                                                 Supabase Postgres (opt., logs)
```

**Principle:** the bot stays dumb about AI. FRIDAY owns intelligence and LLM calls. The bot holds conversation context (last 20 msgs per chat) and ships it with each request. FRIDAY is stateless — it reads the window, replies, forgets.

**Why this split:**
- VPS stays cheap (no LLM inference locally)
- FRIDAY stays edge-friendly (no cold-start DB reads; memory is passed in)
- Swapping LLM providers = change one env var, no bot redeploy
- Privacy: conversation history never persists on Supabase (it lives in the bot's memory, erased on restart unless we later add Mongo persistence)

**Dependencies (two external services):**
- **MongoDB Atlas** — Baileys auth state only. Nothing else.
- **Supabase** — FRIDAY Edge Function + Storage bucket (media) + optional logs table.

---

## 2. The Two Endpoints

Deliberately separate — `/reply` returns a decision, `/invoke` always returns text. Mixing them would force FRIDAY to branch on mode, which is a needless coupling.

### 2.1 `POST /reply` — Autopilot decision (automatic)

Called by the bot when autopilot is ON for a chat, the debounce timer fires, and the bot needs FRIDAY to decide whether and how to respond.

**Request:**
```json
{
  "mode": "autopilot",
  "chat_id": "123@s.whatsapp.net",
  "chat_type": "private",
  "sender_id": "123@s.whatsapp.net",
  "sender_name": "Ali",
  "history": [
    { "role": "user",      "name": "Ali",      "text": "hey are you around?", "ts": "2026-10-31T12:00:00Z" },
    { "role": "assistant", "name": "Phestone", "text": "yep, what's up",    "ts": "2026-10-31T12:00:30Z" },
    { "role": "user",      "name": "Ali",      "text": "need help with X",   "ts": "2026-10-31T12:01:00Z" }
  ],
  "last_message": {
    "text": "need help with X",
    "media": null,
    "quoted": null
  },
  "exchange_index": 1
}
```

- `history` — rolling window, oldest → newest, **max 20** entries (configurable). Includes the current `last_message` as the final entry.
- `chat_type` — `"private"` only (MVP; groups deferred).
- `exchange_index` — 1-based counter for this sender/chat/session. Lets FRIDAY modulate tone ("this is my 8th reply, maybe be brief").
- `media` / `quoted` — `null` in MVP (see §7).

**Response:**
```json
{
  "action": "reply",
  "text": "Boss is away right now — I'm FRIDAY, his assistant. Can I help?",
  "reason": "owner_inactive",
  "conversation_id": "conv_abc123"
}
```

- `action` ∈ `"reply" | "ignore" | "escalate"`.
- `text` — required when `action === "reply"`. Ignored otherwise.
- `reason` — free-form string for logging/debugging.
- `conversation_id` — for correlating logs across bot ↔ FRIDAY.

**Action semantics:**
| Action | Bot behavior |
|---|---|
| `reply` | Send `text` to the chat (with typing simulation — §5) |
| `ignore` | Do nothing. No presence, no read receipt change, no reply. |
| `escalate` | DM owner once with context ("Ali in chat needs you: …"). Bot does **not** reply to sender. |

### 2.2 `POST /invoke` — Manual `phesty` invocation (owner-triggered)

Called when owner runs `!phesty` — always returns text.

**Request:**
```json
{
  "mode": "manual",
  "chat_id": "123@s.whatsapp.net",
  "sender_id": "owner@s.whatsapp.net",
  "text": "explain this image",
  "media": { "type": "image", "storage_path": "friday-media/abc.jpg", "mime": "image/jpeg" },
  "quoted": { "text": "previous message", "sender_name": "Ali" }
}
```

- `text` — may be empty if media-only with a default prompt.
- `media` — optional; see §7.
- `quoted` — optional; context from a replied-to message.

**Response:**
```json
{
  "action": "reply",
  "text": "This image shows a screenshot of a Node.js stack trace...",
  "conversation_id": "conv_def456"
}
```

- `action` is always `"reply"` for `/invoke` in MVP (error paths return HTTP 4xx/5xx — see §8).

---

## 3. Authentication

**Mechanism:** custom shared secret via HTTP header.

```
Authorization: Bearer <FRIDAY_SHARED_SECRET>
```

- Secret is generated once, stored as a Supabase secret (readable only by the Edge Function) and in the VPS `.env`.
- FRIDAY compares with constant-time equality. Missing or wrong secret → HTTP 401, no body detail.
- Rotation: change both sides simultaneously (rare; documented in runbook).

**Why not Supabase JWT / service role / RLS?**
- Single-tenant endpoint (only your bot calls it). RLS/JWT machinery is overkill and adds failure modes (token expiry, clock skew, key rotation).
- A shared secret is simpler to reason about and simpler to rotate.

**🔴 Rule:** the secret never appears in any bot log, error message, or WhatsApp message. The bot logs `[FRIDAY] auth failed` — not the secret.

---

## 4. Memory Model — Bot-Owned, FRIDAY-Stateless

**Where history lives:** in the bot's memory, per chat. Never persisted to Supabase.

- **Rolling buffer:** last **20 messages** per chat (`FRIDAY_CONTEXT_WINDOW=20`). Oldest dropped when full.
- **Buffer entries:** `{ role: "user" | "assistant", name, text, ts }`. No IDs, no metadata beyond that.
- **Reset conditions:** buffer clears on bot restart (in-memory only). **Optional future enhancement:** persist to Mongo (already available for auth) — deferred until it annoys you.
- **Privacy:** nothing about the conversation is stored on Supabase. FRIDAY sees the window in the request body and forgets after responding.

**🟡 Why 20:** enough for in-context multi-turn replies; small enough that a 4-turn exchange doesn't blow the LLM context window or the Groq free-tier token budget. Tunable via env var.

---

## 5. Autopilot State Machine & Timeline

Per chat. The bot runs the state machine; FRIDAY is a pure function called once per firing.

### 5.1 States

```
IDLE  ──(sender msg & autopilot ON)──►  WAITING
WAITING  ──(sender msg)──►  WAITING (timer reset)
WAITING  ──(timer fires)──►  THINKING
THINKING  ──(FRIDAY reply)──►  TYPING
THINKING  ──(FRIDAY ignore)──►  IDLE (wait for next sender msg)
THINKING  ──(FRIDAY escalate)──►  IDLE + owner DM
THINKING  ──(timeout / error)──►  IDLE (silent)
TYPING  ──(typing duration elapsed)──►  IDLE (reply sent)
WAITING  ──(owner sends msg)──►  IDLE (timer cancelled)
THINKING  ──(owner sends msg)──►  IDLE (in-flight call abandoned on arrival)
TYPING  ──(owner sends msg)──►  IDLE (reply suppressed)
ANY  ──(exchange cap reached)──►  CAPPED + owner DM
CAPPED  ──(owner sends msg)──►  IDLE (counter reset)
```

### 5.2 Timeline (config: `AUTOPILOT_TIMER_MS=120000`)

```
t = 0s         Sender sends a message → timer armed
t = 0..N s     Sender sends more msgs → timer resets to t = 0 each time
t ≈ 90–105s    Timer fires (randomized within [0.75×T, 0.875×T])
                 → Bot calls FRIDAY /reply
                 → State: THINKING
t ≈ 92–110s    FRIDAY responds (typically 1–5s for Groq)
                 → If action = reply:
                     Bot sends `composing` presence immediately
                     Bot holds presence for scaled duration (§6)
                     Bot sends reply
                     Bot sends `paused` presence
                     Exchange counter +1
                 → If action = ignore: nothing sent
                 → If action = escalate: owner DM sent, nothing to sender
```

**Why fire before the 2-min mark:** by the time the sender perceives ~2 min of "silence," the bot is *already typing* — it reads as "he was about to reply." This is more human than a reply that appears instantly at 120s.

**Owner interrupt:** if owner sends **any** message in the chat while state ∈ {WAITING, THINKING, TYPING}:
- Cancel pending timer
- Abandon in-flight FRIDAY call (drop the response if it arrives)
- Suppress any pending typing/reply
- Return to IDLE
- Reset exchange counter to 0
- Do **not** send `paused` presence retroactively (owner's own message updates their presence naturally)

---

## 6. Human Typing Simulation

**Presence model:** `composing` before the reply, `paused` after.

**Duration scaled to reply length** — fixed durations look robotic:

| Reply length | Typing duration (base) |
|---|---|
| < 30 chars | 8–15 s |
| 30–150 chars | 15–35 s |
| 150–400 chars | 35–60 s |
| > 400 chars | 60–90 s (cap) |

**Formula:** `typing_ms = clamp(words × 800, 8000, 90000) × random(0.7, 1.3)`

**Combine with the pre-fire interval:** if FRIDAY responds at t=95s and scaled typing duration is 20s, the reply lands at ~115s — natural. If FRIDAY responds at t=100s and scaled duration is 60s, reply lands at t=160s — still natural (it's a long answer).

**Cap:** total time from timer fire to reply send is capped at **90 s** (don't let a 400-word essay take 3 min to "type").

**🟡 Presence is visible.** The sender sees "Phestone is typing…" — that's intentional. It's a deliberate human-like signal. Confirmed acceptable.

**Edge case:** if FRIDAY returns `ignore`, do **not** send `composing`. No presence at all — the sender must not know the bot was considering a reply.

---

## 7. Media Handling

### 7.1 `phesty` with media (MVP)

```
Sender (owner) replies to an image with !phesty <question>
  → Bot downloads media from WhatsApp
  → Bot uploads to Supabase Storage bucket `friday-media` (private)
  → Bot calls FRIDAY /invoke with { type, storage_path, mime }
  → FRIDAY reads the object via Storage SDK, sends to LLM
  → FRIDAY responds with text
  → Bot deletes the storage object (best-effort)
  → Bot sends text reply in chat
```

- **Bucket:** `friday-media` — **private**. Objects accessed only by service role (FRIDAY's Edge Function + bot).
- **Cleanup:** bot deletes after FRIDAY responds. **Also:** a TTL fallback (24h) via a cron-triggered Edge Function or pg_cron — so orphans from crashes don't fill the 1 GB free tier.
- **Size cap:** reject media > 10 MB with a clean error to owner (Edge Function body limit safety).
- **Supported types (MVP):** `image/jpeg`, `image/png`, `image/webp`. Audio/video for `transcribe` / `find` deferred to build phase.

### 7.2 Autopilot + media (deferred)

If sender sends a photo while autopilot is on, the bot in MVP sends FRIDAY `media: null` and only the text (or empty text). FRIDAY likely returns `ignore` (no text to respond to). **Media-aware autopilot is deferred to build phase** — adds cost/complexity and isn't needed for the initial "reply to messages while I'm away" goal.

**🟡 Flag:** this is a deliberate MVP scope cut. Confirm acceptable.

---

## 8. Error, Timeout, Retry

| Scenario | Behavior |
|---|---|
| FRIDAY returns HTTP 401 | Bot logs `[FRIDAY] auth failed`, silent to sender. 🔴 **Alert owner via separate DM** — the bot is misconfigured. |
| FRIDAY returns 4xx (bad request) | Bot logs full response, silent to sender. Do **not** retry. |
| FRIDAY returns 5xx | Bot retries **once** after 2s. If retry fails → silent. |
| FRIDAY times out (bot-side cap **15s**) | Silent fail, log. |
| FRIDAY returns malformed JSON | Log raw body, silent to sender. |
| LLM provider errors inside FRIDAY | FRIDAY returns `{ action: "ignore", reason: "llm_error" }` with HTTP 200. Bot silent. |
| Cold start (Edge Function) | Covered by the 15s timeout; accept occasional first-call failure. |
| Storage upload fails (`phesty`) | Owner sees "couldn't process media" reply in their chat. Logged. |

**🔴 The unifying rule:** **FRIDAY errors never leak to WhatsApp.** Users see nothing (autopilot) or a clean generic error (manual `phesty`). The owner sees everything via the log sink. This fixes the old bot's silent-catch problem — silent **to users**, loud **to you**.

---

## 9. LLM Provider Abstraction (Inside FRIDAY)

FRIDAY wraps LLM calls behind a tiny provider interface:

```
callLLM(provider, messages, options) -> { text, usage, provider_used }
```

- **Primary:** Groq (fast, free tier, what the old bot used).
- **Fallback:** Gemini (set via env: `LLM_PRIMARY=groq`, `LLM_FALLBACK=gemini`).
- **Failure mode:** if primary fails (rate limit, 5xx, timeout) → try fallback once → if both fail, FRIDAY returns `{ action: "ignore", reason: "llm_error" }`.
- **Model selection:** env vars `GROQ_MODEL`, `GEMINI_MODEL` — no hardcoding.
- **Token budget:** per-request cap (e.g. `LLM_MAX_TOKENS=800`) to bound cost.

**🟡 Note:** Groq free-tier limits (RPM + TPM) are generous for single-user usage. The 10-exchange cap per chat further caps blast radius. If we ever go multi-user, we revisit.

---

## 10. Secrets Inventory

| Secret | Lives in | Used by |
|---|---|---|
| `FRIDAY_SHARED_SECRET` | Supabase secret **and** VPS `.env` | Both sides (auth) |
| `GROQ_API_KEY` | Supabase secret | FRIDAY only |
| `GEMINI_API_KEY` | Supabase secret | FRIDAY only |
| `LLM_PRIMARY`, `LLM_FALLBACK` | Supabase env | FRIDAY only |
| `SUPABASE_URL` | VPS `.env` | Bot (Storage uploads, invoke calls) |
| `SUPABASE_SERVICE_KEY` | VPS `.env` | Bot (**Storage write only** — scoped policy, see flag) |
| `MONGODB_URI` | VPS `.env` | Bot (auth state only) |
| `OWNER_NUMBERS` | VPS `.env` | Bot (owner gate) |
| `AUTOPILOT_TIMER_MS`, `AUTOPILOT_MAX_EXCHANGES`, `FRIDAY_CONTEXT_WINDOW` | VPS `.env` | Bot (tuning) |
| Deploy SSH key | GitHub Actions secret | Deploy only |

**🟡 Flag:** `SUPABASE_SERVICE_KEY` on the bot is a full-access key. Preferred: create a **scoped Storage-only role** or use a **Storage policy** limiting writes to the `friday-media` bucket. Decide during Phase 4 setup. If scoping proves too fiddly, accept service key for MVP and rotate periodically.

---

## 11. Decisions Log (Phase 2)

| # | Decision | Rationale | Date |
|---|---|---|---|
| D11 | Bot owns memory; FRIDAY is stateless | Edge-friendly, no cold-start DB, privacy | 2026-10-31 |
| D12 | Rolling buffer = 20 msgs per chat, in-memory, configurable | Enough context, bounded tokens, simple | 2026-10-31 |
| D13 | Two endpoints (`/reply`, `/invoke`), separate concerns | Avoid mode-branching inside FRIDAY | 2026-10-31 |
| D14 | Shared-secret Bearer auth, not JWT/RLS | Single-tenant; simpler; fewer failure modes | 2026-10-31 |
| D15 | Debounce timer 2 min, fires at 75–87.5% (90–105 s) | Human-like; FRIDAY time to think | 2026-10-31 |
| D16 | Typing duration scales to reply length with ±30% jitter | Fixed durations look robotic | 2026-10-31 |
| D17 | Anti-loop = **10 exchanges per sender per chat per away session** | Owner confirmed; caps cost + ban risk | 2026-10-31 |
| D18 | **Away session** = owner quiet >2 min → until owner msgs OR 4 h pass | Bounded duration prevents runaway sessions | 2026-10-31 |
| D19 | Exchange cap → silent + **one** escalate DM to owner | Safety valve; not chatty | 2026-10-31 |
| D20 | Owner message resets counter + cancels timer + suppresses in-flight reply | Owner presence is the kill switch | 2026-10-31 |
| D21 | FRIDAY `escalate` action (LLM-driven) sends owner DM, no sender reply | Separate from local cap escalation | 2026-10-31 |
| D22 | Media via Supabase Storage (private bucket), TTL cleanup 24 h | Scales; safe; free tier OK | 2026-10-31 |
| D23 | Media-aware autopilot **deferred** to build phase | MVP scope cut; text-only autopilot sufficient | 2026-10-31 |
| D24 | Groups: **private only** for autopilot (MVP) | Matches old behavior; lower ban risk | 2026-10-31 |
| D25 | Groq primary, Gemini fallback, provider abstraction | Resiliant + replaceable | 2026-10-31 |
| D26 | Errors **never** leak to WhatsApp; loud to owner logs | Fixes old bot's silent-catch bug | 2026-10-31 |
| D27 | Bot-side FRIDAY timeout = 15 s; one retry on 5xx | Balances reliability vs. latency | 2026-10-31 |
| D28 | 4-hour session cap → bot silent until owner msgs (no auto new session) | Safest default; prevents daily loops | 2026-10-31 |

---

## 12. Open Items Carried Forward

| Item | Carried to | Notes |
|---|---|---|
| Log sink format & location (Supabase table vs VPS file vs both) | Phase 3 | Bot errors + FRIDAY errors must be queryable |
| Presence helper API | Phase 3 | `composing` / `paused` used by autopilot + phesty |
| Media download + upload helper API | Phase 3 | Used by `vs`, `sick`, `phesty`, `transcribe`, `find` |
| Conversation buffer implementation (Map in memory? ring buffer?) | Phase 3 | Per-chat, LRU-evicted |
| Storage bucket setup + TTL job | Phase 4 | Supabase side |
| Service-key scoping (Storage-only vs full) | Phase 4 | Security hygiene |
| Media-aware autopilot | Build phase | Deferred per D23 |
| Group autopilot | Build phase | Deferred per D24 |
| FRIDAY system prompt / persona design | Build phase | Voice, tone, escalation thresholds |
| LLM model IDs + token cap | Build phase | Env-driven |

---

## 13. Definition of Done for Phase 2

- [x] Boundary architecture recorded
- [x] Both endpoints fully specced (request + response)
- [x] Auth mechanism chosen
- [x] Memory model locked (bot-owned, 20-msg buffer)
- [x] Autopilot state machine + timeline locked
- [x] Typing simulation formula locked
- [x] Exchange cap + away session semantics locked
- [x] Media flow locked (Supabase Storage, TTL)
- [x] Error / timeout / retry policy locked
- [x] LLM provider abstraction locked
- [x] Secrets inventory recorded
- [x] Decisions log recorded
- [x] Open items carried forward

**Phase 2 status: COMPLETE.**

---

*Next: `03-command-architecture.md` (Phase 3).*