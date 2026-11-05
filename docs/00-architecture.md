# 00 — Architecture

> **Start here.** This is the one-page map of the project. Everything
> else (phases 01–04) drills into a specific slice.

## What this is

`its-phestone` is a personal WhatsApp assistant bot running on a
free-tier Oracle Cloud VPS. It acts as its owner — viewing statuses,
recovering deleted messages, and replying on the owner's behalf via
an AI persona called FRIDAY when the owner is away. It obeys **only
the owner**. No one else.

## System context
```text
WhatsApp ◄──► Baileys bot (Oracle VPS) ──HTTPS──► FRIDAY (Supabase Edge Function)
                │      │
                │      ▼
                │    LLM provider (Groq primary)
                │      │
                ▼      ▼
            Mongo Atlas   Supabase Storage
           (auth state)   (media, TTL-cleaned)
```

## Services

| Piece | Service | Free tier | Purpose |
|---|---|---|---|
| Compute | Oracle Cloud ARM | Always Free (1 OCPU / 6 GB) | Runs the Baileys bot 24/7 |
| Auth store | MongoDB Atlas M0 | 512 MB | Baileys session state |
| AI host | Supabase Edge Functions | 500 K invocations/mo | FRIDAY endpoint |
| Media store | Supabase Storage | 1 GB | `phesty` image uploads |
| Code + CI/CD | GitHub + Actions | Free | Storage + auto-deploy |
| Process mgr | PM2 | (on VPS) | Keep bot alive, restart on crash |

**Cash cost: $0.**

## Non-negotiables

These decisions govern every design choice downstream. Do not
casually violate them; if one must change, update the phase doc that
owns it and note why in the decisions log.

1. **Owner-only, silent.** Router enforces at message receipt;
   non-owner commands are silently skipped. No "you're not permitted"
   replies. No unknown-command replies. The bot never announces
   itself.
2. **Silent to users, loud to owner.** Every error goes to the log
   sink and (rate-limited) to the owner DM. No bare `try/catch`. No
   errors shown to chat participants.
3. **No hardcoded secrets.** All via env. `.env` never committed.
4. **No local hotfixes on the VPS.** Deploys only via GitHub Actions
   (`git reset --hard origin/main`). Single source of truth.
5. **No auto-presence in commands.** Only `phesty` and the autopilot
   event handler send `composing` / `paused`. Everything else is
   silent.
6. **FRIDAY is stateless.** Conversation history lives in the bot's
   in-memory buffer, shipped with each request. Nothing about chats
   persists on Supabase.
7. **Fail-fast on config.** Missing/invalid env → throw at startup,
   not at first use.

## Project layout
```text
docs/                  ← you are here
bot/                   ← Baileys bot (Node.js, PM2-managed)
supabase/
  functions/
    friday/            ← Edge Function (TypeScript/Deno)
ecosystem.config.js
.github/workflows/deploy.yml
```

## Doc index

| Doc | Contents |
|---|---|
| `01-feature-inventory.md` | 14 commands, 6 anchors, settings model, security model |
| `02-friday-contract.md` | Endpoint schemas, memory model, autopilot state machine, media flow |
| `03-command-architecture.md` | Directory structure, router, settings module, error policy, helpers |
| `04-infra-runbook.md` | Step-by-step setup of every service, verification checklist |

## Glossary

| Term | Meaning |
|---|---|
| **Owner** | The single WhatsApp number the bot obeys. Defined in `OWNER_NUMBERS`. |
| **FRIDAY** | The AI persona hosted on Supabase Edge Functions. |
| **Autopilot** | Per-chat mode where FRIDAY replies on the owner's behalf after a debounce window. |
| **Away session** | The time span from when the owner goes quiet to when they next message, or 4 h elapsed, whichever comes first. |
| **Exchange cap** | Max consecutive FRIDAY replies per sender per chat per away session (default 10). |
| **Anchor command** | One of six commands (`help`, `autoview`, `vs`, `antidelete`, `autopilot`, `phesty`) that the framework is built and tested against first. |
| **Silent skip** | Router refuses to route, without replying. Used for non-owners, unknown commands, cooldowns. |

---

*If you're new: read this file, then 01 → 02 → 03 → 04 in order.*
