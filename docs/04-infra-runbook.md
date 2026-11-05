# Phase 4 — Infrastructure Runbook

> **Status:** LOCKED (Phase 4 complete)
> **Last updated:** 2026-10-31
> **Owner:** Phestone
> **Purpose:** Step-by-step manual setup of every piece of infrastructure needed to run the bot. Every step has a verification. Ends with a working bot receiving `!ping` replies from a VPS, deployed via GitHub Actions, with FRIDAY reachable.

---

## 0. Summary

| Piece | Service | Free tier | Purpose |
|---|---|---|---|
| Compute | **Oracle Cloud** ARM VM | Always Free (4 OCPU, 24 GB) | Runs the Baileys bot |
| Auth store | **MongoDB Atlas** M0 | 512 MB | Baileys session state (survives restarts) |
| AI host | **Supabase** Edge Functions | 500 K invocations/mo | FRIDAY endpoint |
| Media store | **Supabase** Storage | 1 GB | `phesty` image uploads |
| Code + CI/CD | **GitHub** + Actions | Free (public or private) | Code storage + auto-deploy |

**Total cash cost: $0.** (Oracle signup requires a credit card for identity verification but does not charge on the Always Free tier.)

**Active work time:** ~1.5–2 hours. **Wall-clock time:** add Oracle verification wait (5 min – 24 h).

---

## 1. Prerequisites

Before starting:

- [ ] **A credit/debit card** for Oracle signup (verification only, not charged)
- [ ] **A way to SSH from your device** — recommend **Termux** (F-Droid or Play Store) on Android, or **Termius** (has free tier), or a laptop
- [ ] **A phone number** for the bot to use — recommend a **dedicated SIM**, not your main. WhatsApp bans hit hard on automation numbers.
- [ ] **WhatsApp on that dedicated number** installed and logged in (so you can scan/pair from it)
- [ ] **GitHub account**
- [ ] **A text editor** — whatever you use for `.md` files; Android Studio is fine for the runbook, but for `.ts`/`.js` a lighter editor may be easier

---

## 2. Order of Operations

Steps that **must be sequential** are numbered. Steps that **can run in parallel** are noted.

```
A.  Oracle signup  ──────────────────────────────┐  (start first — verification may queue)
                                                  │
B.  MongoDB Atlas setup  ─┐                       │
C.  Supabase setup       ─┼── can be done while A │
D.  GitHub repo setup    ─┘   is verifying        │
                                                  │
E.  Oracle VM provisioning (needs A verified) ◄───┘
F.  VPS hardening (needs E)
G.  Deploy bot code to VPS (needs F + D)
H.  First pairing (needs G + B)
I.  GitHub Actions wiring (needs G + D)
J.  Verification checklist (needs everything)
```

**Recommended:** start A, then do B, C, D while waiting, then E onwards.

---

## 3. Section A — Oracle Cloud Signup

### A.1 Create the account
1. Go to `cloud.oracle.com` → **Sign Up**
2. Country: your country. Home region: **pick the closest region that lists ARM Ampere A1 under "Always Free"** — most do, but verify.
3. Email, password. Verify email.
4. **Card verification:** Oracle charges a temporary hold (~$1 equivalent, refunded). This is normal — free tier stays free.
5. Wait for verification email. **This can take minutes or up to 24 hours.** Move on to Sections B–D.

### A.2 Verify free tier is active
- Console → **Governance & Administration** → **Limits, Quotas and Usage**
- Confirm you see **Ampere A1 Compute** with `4 OCPU / 24 GB` limit under your tenancy
- If you don't see it → contact Oracle support *before* proceeding

**✅ Verification:** you can log in to the Oracle Cloud Console and see the Ampere A1 free-tier limits.

---

## 4. Section B — MongoDB Atlas (auth store)

### B.1 Create the cluster
1. `mongodb.com/cloud/atlas` → **Sign Up** (free, no card)
2. Create an **M0** cluster (free tier). Region: closest to your Oracle region if possible — reduces auth-state latency.
3. Wait ~2 min for cluster to provision.

### B.2 Create the database user
- **Database Access** → **Add New Database User**
- Username: e.g. `phestone-bot`
- Password: generate strong (32+ chars), **save it**
- Role: **Read and write to any database** (M0 doesn't support fine-grained roles on free tier — acceptable for this use case)

### B.3 Whitelist the VPS IP
- **Network Access** → **Add IP Address**
- **Problem:** you don't have the VPS IP yet. Two options:
    - **Option 1 (loose, temporary):** add `0.0.0.0/0` now, tighten after Section E.
    - **Option 2 (recommended):** skip this until after Section E, then come back.

### B.4 Get the connection string
- **Clusters** → **Connect** → **Drivers** → Node.js
- Copy the string — format: `mongodb+srv://phestone-bot:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
- Save it as `MONGODB_URI` for later. **Substitute the real password.**

**✅ Verification:** (after B.3 with a real IP or `0.0.0.0/0`) you can run `mongosh "<URI>"` from any machine and connect. If you don't have `mongosh` handy, skip — the bot will fail with a clear error if the URI is wrong.

---

## 5. Section C — Supabase (FRIDAY + Storage)

### C.1 Create the project
1. `supabase.com` → **Sign Up** (GitHub login is easiest)
2. **New project** → name `phestone-friday`, region closest to your Oracle region, strong DB password
3. Wait ~2 min for provisioning

### C.2 Capture credentials
- **Project Settings** → **API**
- Save:
    - `SUPABASE_URL` (e.g. `https://xxxxx.supabase.co`)
    - `SUPABASE_ANON_KEY`
    - `SUPABASE_SERVICE_ROLE_KEY` — **treat as a secret; only on the VPS**

### C.3 Create the Storage bucket
- **Storage** → **New bucket**
- Name: `friday-media`
- **Public: OFF** (private)
- File size limit: 10 MB (matches Phase 2 §7.1)
- Save

### C.4 Apply a Storage policy for the bot
- **Storage** → `friday-media` → **Policies**
- Since the bot uses the service role key, no policy is strictly needed (service role bypasses RLS). **But** to limit blast radius:
    - Create a policy that allows `INSERT` only to `friday-media/*` for a role you create
    - Create a storage-only API key in **Project Settings → API → "Create a new API key"** scoped to that role
    - Use that key on the VPS instead of the full service role key
- **If this is fiddly, accept the service role key for MVP** (documented risk in Phase 2 §10). Tighten in Phase 5 if time permits.

### C.5 Install the Supabase CLI (on your laptop, or skip if using dashboard deployment)
- `npm install -g supabase` (or `brew install supabase/tap/supabase`)
- `supabase login`
- `supabase link --project-ref <your-project-ref>` (from Project Settings → General → Reference ID)

### C.6 Create the FRIDAY Edge Function scaffold
- The IDE agent will write the actual function code in Phase 5. For now, just create the directory:
  ```
  supabase/functions/friday/index.ts
  ```
- A minimal placeholder that returns `{ ok: true }` is enough to deploy and verify wiring.

### C.7 Set Edge Function secrets
```bash
supabase secrets set \
  FRIDAY_SHARED_SECRET="$(openssl rand -hex 32)" \
  GROQ_API_KEY="gsk_..." \
  GEMINI_API_KEY="..." \
  LLM_PRIMARY="groq" \
  LLM_FALLBACK="gemini" \
  LLM_MAX_TOKENS="800"
```
**🔴 Copy the generated `FRIDAY_SHARED_SECRET` value** — you need it in Section F. It won't be shown again by `supabase secrets list` (only names, not values).

**How to generate and capture the secret separately if the above is awkward:**
```bash
openssl rand -hex 32 > friday-secret.txt
cat friday-secret.txt
supabase secrets set FRIDAY_SHARED_SECRET="$(cat friday-secret.txt)"
# then save friday-secret.txt somewhere safe, delete after pasting into VPS .env
```

### C.8 Deploy the placeholder function
```bash
supabase functions deploy friday
```

### C.9 Get the function URL
- Dashboard → **Edge Functions** → `friday` → the URL is `https://<project-ref>.supabase.co/functions/v1/friday`
- Or `supabase functions list`

**✅ Verification:** `curl -X POST -H "Authorization: Bearer <FRIDAY_SHARED_SECRET>" <function-url>` returns the placeholder JSON (with 200). Without the header, returns 401.

### C.10 Create the log table (optional but recommended)
- SQL Editor → run the Phase 5 agent's migration for a `bot_logs` table (schema defined during Phase 5)
- For now, skip if the agent hasn't written it — the bot can log to VPS files first, add the table later

---

## 6. Section D — GitHub Repository

### D.1 Create the repo
1. GitHub → **New repository**
2. Name: `its-phestone` (or whatever you like)
3. **Private** (recommended — contains `.env` references, no secrets but still)
4. No README, no `.gitignore` (we'll add)

### D.2 Clone locally (or on the VPS after Section F)
```bash
git clone git@github.com:<you>/its-phestone.git
cd its-phestone
```

### D.3 Create initial structure
The IDE agent will populate `bot/` and `supabase/functions/friday/` in Phase 5. For now, just create:
```
its-phestone/
├── docs/
│   ├── 00-architecture.md
│   ├── 01-feature-inventory.md
│   ├── 02-friday-contract.md
│   ├── 03-command-architecture.md
│   └── 04-infra-runbook.md
├── bot/                       ← empty for now
├── supabase/functions/friday/ ← empty for now
├── .gitignore
└── README.md
```

### D.4 `.gitignore` (create this file now)
```gitignore
# Node
node_modules/
npm-debug.log*
yarn-error.log*

# Env
.env
.env.*
!.env.example

# Bot state
session/
settings.json
*.log

# IDE
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db
```

### D.5 Commit and push
```bash
git add .
git commit -m "chore: initial structure with phase 1-4 docs"
git push origin main
```

### D.6 Branch protection (recommended, optional)
- **Settings** → **Branches** → **Add rule** for `main`
- Require PR before merge (optional — for solo dev, maybe just protect against force-push)
- Skip if this slows you down; the important thing is the deploy workflow

**✅ Verification:** the repo exists on GitHub, has the docs, and `git push` works.

---

## 7. Section E — Oracle VM Provisioning

**Prerequisite:** Section A verification complete.

### E.1 Reserve a static public IP (do this *before* the VM)
- Console → **Networking** → **Reserved Public IPs** → **Reserve Public IP**
- Name it `its-phestone-ip`. Save the IP — this is what the bot will live behind.
- (Static IP is free with Always Free and prevents the IP changing on VM restart.)

### E.2 Create the VM
- Console → **Compute** → **Instances** → **Create Instance**
- **Name:** `its-phestone`
- **Image:** **Ubuntu 22.04 LTS** (or 24.04 if available — Baileys requires Node 20+, both are fine)
- **Shape:** **Ampere A1.Flex** → **1 OCPU, 6 GB RAM** (you have 4 OCPU / 24 GB available; 1/6 is plenty for the bot, leaves room if you ever need more)
- **Networking:** default VCN, **assign the reserved public IP** from E.1
- **Add SSH keys:** **Generate a key pair** → download the **private key** (`.key` or `.pem`). Save it somewhere safe (e.g. `~/.ssh/its-phestone.key`). This is your only way in.
- **Boot volume:** default is fine (50 GB) — but **check "Specify a custom boot volume size" → 50 GB** (default may be small)
- **Create**

### E.3 Troubleshooting: "Out of host capacity"
If VM creation fails with `Out of host capacity`:
- Try a **different availability domain** (AD-2 or AD-3 instead of AD-1)
- Try again later (capacity fluctuates; scripts exist that retry every 5 min)
- Worst case: switch to **AMD micro** shape (also Always Free: 1 OCPU / 1 GB RAM) — tight but workable for Baileys; you'd need to skip `ffmpeg`-heavy commands (`find`, `transcribe`) or offload them
- If AMD micro also fails after 24 h → **Plan B** (§11)

### E.4 Get the VM's public IP
- Console → Instance details → **Public IP address**
- Confirm it matches the reserved IP from E.1
- Save as `VPS_IP`

### E.5 First SSH
From your device:
```bash
chmod 600 ~/.ssh/its-phestone.key
ssh -i ~/.ssh/its-phestone.key ubuntu@<VPS_IP>
```
- **Default user is `ubuntu`** on Ubuntu images (not `opc`)
- If it hangs → check the security list (§E.6)

### E.6 Open SSH in the firewall (usually already open)
- Oracle VCN → **Security Lists** → default → ensure **ingress rule TCP:22 from `0.0.0.0/0`** exists (it usually does)
- **Do not open HTTP/HTTPS** — the bot doesn't serve web traffic

**✅ Verification:** you're SSH'd into the VM as `ubuntu@<hostname>`.

---

## 8. Section F — VPS Hardening & Setup

Run these on the VPS.

### F.1 Update packages
```bash
sudo apt update && sudo apt upgrade -y
```

### F.2 Install Node.js 20 LTS
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # should be v20.x
npm --version
```

### F.3 Install PM2 + log rotation + git + ffmpeg
```bash
sudo npm install -g pm2
pm2 install pm2-logrotate
sudo apt install -y git ffmpeg
```
`ffmpeg` is for `find` / `transcribe` media processing later — install now so it's ready.

### F.4 Configure the firewall (ufw)
Oracle Ubuntu images come with default `iptables` rules that can be confusing. Simplest reliable approach:
```bash
sudo iptables -I INPUT -p tcp --dport 22 -j ACCEPT
sudo apt install -y iptables-persistent
sudo netfilter-persistent save
```
Skip `ufw` — Oracle's default rules already block everything except what's in the VCN security list. Just confirm SSH stays open.

### F.5 Create project directory
```bash
mkdir -p ~/its-phestone
cd ~/its-phestone
```
The bot will live at `/home/ubuntu/its-phestone/bot/`.

### F.6 Clone the repo on the VPS
```bash
# Generate a read-only deploy key on the VPS
ssh-keygen -t ed25519 -C "vps-its-phestone" -f ~/.ssh/github_deploy -N ""
cat ~/.ssh/github_deploy.pub
```
- Copy the public key
- GitHub repo → **Settings** → **Deploy keys** → **Add deploy key** → paste, **uncheck "Allow write access"** → Add
- Back on VPS:
```bash
git clone git@github.com:<you>/its-phestone.git ~/its-phestone
cd ~/its-phestone
```

### F.7 Create the VPS `.env`
```bash
cd ~/its-phestone/bot   # once bot/ exists (Phase 5); for now create at repo root
cp .env.example .env
nano .env
```
Values (will be filled across sections):
```
PREFIX=!
OWNER_NUMBERS=<your-owner-number-international-format-without-plus>
BRANDING=                         # leave empty (D43)

MONGODB_URI=mongodb+srv://...     # from B.4
SUPABASE_URL=https://...          # from C.2
SUPABASE_SERVICE_KEY=...          # from C.2 (scoped key if C.4 was done)
FRIDAY_URL=https://.../functions/v1/friday   # from C.9
FRIDAY_SHARED_SECRET=...          # from C.7

AUTOPILOT_TIMER_MS=120000
AUTOPILOT_MAX_EXCHANGES=10
FRIDAY_CONTEXT_WINDOW=20
```
```bash
chmod 600 .env
```

### F.8 Back in MongoDB Atlas — whitelist the VPS IP
- **Network Access** → remove the temporary `0.0.0.0/0` if you added it → **Add IP** `<VPS_IP>/32`
- If the VPS IP changes (shouldn't with a reserved IP), update this

### F.9 Install the bot dependencies (once `bot/package.json` exists in Phase 5)
```bash
cd ~/its-phestone/bot
npm install --omit=dev
```

**✅ Verification:** `node --version` shows 20.x, `pm2 --version` works, `ffmpeg -version` works, `.env` has all keys.

---

## 9. Section G — PM2 Setup

### G.1 `ecosystem.config.js` (the IDE agent will generate; verify it matches)
```js
module.exports = {
  apps: [{
    name: 'its-phestone',
    script: './bot/index.js',
    cwd: '/home/ubuntu/its-phestone',
    autorestart: true,
    max_restarts: 20,        // in 60s window; PM2 backs off after
    min_uptime: '30s',       // if it dies within 30s, counts as a crash
    restart_delay: 5000,     // 5s between restarts
    max_memory_restart: '400M',
    env_file: '/home/ubuntu/its-phestone/bot/.env',
    out_file: '/home/ubuntu/its-phestone/logs/out.log',
    error_file: '/home/ubuntu/its-phestone/logs/err.log',
    merge_logs: true,
    time: true,              // timestamp every log line
  }],
};
```

### G.2 Start PM2
```bash
cd ~/its-phestone
mkdir -p logs
pm2 start ecosystem.config.js
pm2 save
pm2 startup
# PM2 prints a sudo command — run it (copies startup script to systemd)
```

### G.3 Verify PM2 survives reboot
```bash
sudo reboot
# wait 30s
ssh -i ~/.ssh/its-phestone.key ubuntu@<VPS_IP>
pm2 status    # its-phestone should be 'online'
```

**✅ Verification:** after reboot, `pm2 status` shows the bot online.

**🟡 Note:** at this stage the bot will crash on startup because the bot code doesn't exist yet (Phase 5). PM2 will show it as `errored` and stop after `max_restarts`. That's expected. The PM2 config is verified when the bot *does* exist. For now, just verify `pm2 status` works and the logs directory is written to.

---

## 10. Section H — First Pairing (after Phase 5 bot code exists)

This section is a placeholder until Phase 5 builds the bot. Documenting the flow now so it's ready:

### H.1 Deploy bot code (via Section I's GitHub Actions, or manually)
```bash
cd ~/its-phestone
git pull
cd bot && npm install --omit=dev
pm2 restart its-phestone
```

### H.2 Watch logs for the pairing code
```bash
pm2 logs its-phestone --lines 50
```
On first run (no session in Mongo), the bot logs:
```
[connection] No session found — pairing mode
[connection] Pairing code: ABCD-1234
```
**(The code is only valid for ~60 seconds — have WhatsApp ready.)**

### H.3 Pair from the bot's WhatsApp
- Open WhatsApp on the dedicated number
- **Settings → Linked Devices → Link a device → Link with phone number instead**
- Enter the pairing code (with or without the dash)
- Wait for "connected"
- PM2 logs should show `[connection] Connected`

### H.4 Verify session persisted to Mongo
```bash
# restart and confirm no re-pair
pm2 restart its-phestone
pm2 logs its-phestone --lines 20
# should NOT show a new pairing code; should show "Connected"
```

**✅ Verification:** bot connects without a new pairing code after restart.

---

## 11. Section I — GitHub Actions (auto-deploy)

### I.1 Generate a deploy SSH key pair
- **On the VPS** (or your laptop — either is fine, but keep the private key out of the repo):
```bash
ssh-keygen -t ed25519 -C "gha-its-phestone-deploy" -f /tmp/phestone_gha -N ""
cat /tmp/phestone_gha.pub   # add to ~/.ssh/authorized_keys on the VPS
```
```bash
# On the VPS:
cat /tmp/phestone_gha.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```
- Copy the private key (`/tmp/phestone_gha`) contents.

### I.2 Add GitHub Actions secrets
GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|---|---|
| `VPS_HOST` | `<VPS_IP>` |
| `VPS_USER` | `ubuntu` |
| `VPS_SSH_KEY` | contents of `/tmp/phestone_gha` (private) |

Delete `/tmp/phestone_gha*` after.

### I.3 Create the workflow file (agent will generate; verify it matches)
`.github/workflows/deploy.yml`:
```yaml
name: Deploy bot to VPS

on:
  push:
    branches: [main]
    paths:
      - 'bot/**'
      - 'ecosystem.config.js'
      - '.github/workflows/deploy.yml'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy over SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            set -e
            cd ~/its-phestone
            git fetch origin main
            git reset --hard origin/main
            cd bot && npm install --omit=dev
            pm2 reload its-phestone --update-env
            pm2 save
```

**Key details:**
- `paths:` filter — only deploys when `bot/` or `ecosystem.config.js` or the workflow itself changes. Documentation-only pushes don't redeploy the bot.
- `pm2 reload` — graceful reload (zero-downtime), not `restart`. Falls back to restart if reload fails.
- `git reset --hard origin/main` — not `git pull`. Ensures the VPS is exactly at remote `main`, discarding any local hotfixes. **This means: never edit code directly on the VPS.** Always via GitHub.

### I.4 Test the deploy
- Make a trivial change to a `bot/` file, commit, push
- GitHub → **Actions** tab → watch the workflow run
- Should complete in ~30 s
- `pm2 status` on VPS still shows `online`

**✅ Verification:** a `git push` to `main` triggers the workflow, which completes green, and the bot stays online.

---

## 12. Section J — End-to-End Verification Checklist

After Phase 5 has built the bot code, run through this:

- [ ] **Bot online:** `pm2 status` → `online`
- [ ] **Basic reply:** from owner number, send `!ping` → bot replies
- [ ] **Non-owner silence:** from a *non-owner* number, send `!ping` → **no reply**
- [ ] **Unknown command silence:** from owner, send `!notacommand` → **no reply**
- [ ] **Settings persist:** `!antidelete all` → `pm2 restart its-phestone` → `!antidelete` shows `all`
- [ ] **Session persists:** `pm2 restart its-phestone` → no re-pairing, bot reconnects
- [ ] **Autoview:** `!autoview on` → someone posts a status → it's marked viewed (check their phone)
- [ ] **Antidelete:** `!antidelete all` → someone sends + deletes a message → you receive a DM with the content
- [ ] **Phesty (text):** `!phesty what's 2+2` → FRIDAY replies
- [ ] **Phesty (image):** reply to an image with `!phesty what is this` → FRIDAY describes it
- [ ] **Storage cleanup:** after `phesty` image test, `friday-media` bucket should be empty (or have only one object briefly)
- [ ] **Autopilot:** `!autopilot` in a chat with a test sender → sender messages → after ~2 min, FRIDAY replies with typing indicator
- [ ] **Autopilot owner-interrupt:** sender messages → *you* message before 2 min → no bot reply
- [ ] **Autopilot cap:** keep messaging until exchange cap (10) → bot goes silent, you get one escalation DM
- [ ] **Deploy:** `git push` a trivial change → GH Actions deploys → bot still online
- [ ] **Reboot resilience:** `sudo reboot` → wait → bot auto-reconnects via PM2, no re-pairing

---

## 13. Troubleshooting / Gotchas

| Symptom | Likely cause | Fix |
|---|---|---|
| VM won't create — "Out of host capacity" | Oracle ARM capacity in your AD | Try other ADs, retry later, or use AMD micro (§E.3) |
| SSH hangs | Security list blocking 22, or wrong user | Confirm VCN ingress for 22; user is `ubuntu` not `opc` |
| Mongo connection timeout | IP not whitelisted | Atlas → Network Access → add `<VPS_IP>/32` |
| Bot pairing loop | Session not writing to Mongo | Check `MONGODB_URI`; check DB user role; check collection name |
| `pm2: command not found` after reboot | PM2 startup not installed | `pm2 startup` then run the printed sudo command |
| GH Actions fails at SSH | Deploy key not in `authorized_keys` | Re-append `phestone_gha.pub` |
| `phesty` image fails | Storage bucket wrong / service key wrong | Verify bucket `friday-media`, key from C.4 |
| FRIDAY 401 | Secret mismatch | Compare `FRIDAY_SHARED_SECRET` in Supabase secrets vs VPS `.env` |
| Logs not rotating | `pm2-logrotate` not installed | `pm2 install pm2-logrotate`; set `pm2 set pm2-logrotate:max_size 10M` |

---

## 14. Plan B — If Oracle Free Tier Fails

If after 24–48 h you cannot get a working VM:

### Plan B1 — HeavenCloud (PaaS, free)
- Sign up at HeavenCloud (or similar free bot-hosting provider)
- Free tier: ~715 MB RAM, 1 GB SSD, no idle sleep
- **Does not support custom ports / SSH** — deploy via git push or file upload
- **Auth state still goes to Mongo** (from Section B), so no re-pairing on migration
- **Caveat:** no PM2, no `ffmpeg` control, limited logs. Acceptable fallback.

### Plan B2 — Oracle AMD micro instance
- Same Oracle account, but AMD shape (`VM.Standard.E2.1.Micro` — 1 OCPU, 1 GB RAM)
- Also Always Free
- Baileys runs on 1 GB, but `ffmpeg` may swap
- **Mitigation:** defer `find` / `transcribe` commands; run them via external API only

### Plan B3 — Paid fallback ($3–5/mo)
- Hetzner CX11 (~€3.29/mo) or Contabo VPS S (~€5/mo)
- Full control, more RAM, better than Oracle free tier
- Only if free tier is truly impossible for your region/account

**The goal is $0.** If Oracle works, great. If not, HeavenCloud is the next-best free option. Paid is the last resort.

---

## 15. Cost Guardrails (Stay at $0)

| Service | Free tier | What to watch |
|---|---|---|
| Oracle | 4 OCPU / 24 GB ARM, 200 GB storage, 10 TB egress/mo | Idle instances can be reclaimed — bot runs 24/7 so you're fine |
| Atlas M0 | 512 MB storage, 500 connections | Auth state is tiny (~KB); fine |
| Supabase | 500 K Edge Function invocations/mo, 1 GB storage, 500 MB DB | A chatty bot could hit invocation limits; 10-exchange cap protects this |
| GitHub | 2000 Actions min/mo (private repos) | Deploys take ~30 s; ~4000 deploys/mo would hit the cap — you won't |
| Oracle egress | 10 TB/mo | WhatsApp media downloads count; massive headroom |

**Alerts to set up:**
- Atlas: email alerts at 80% storage (Settings → Alerts)
- Supabase: budget alerts (Dashboard → Settings → Billing → Alerts)
- Oracle: free-tier utilization alert (Governance → Limits, Quotas and Usage → create budget alert at $0)

---

## 16. Backup & Recovery

| Data | Where | Backup strategy |
|---|---|---|
| **Baileys auth state** | Mongo Atlas M0 | M0 has **no automatic backups**. Recovery = **re-pair** (30 s via Section H.2). Document this — don't rely on backups. |
| **Settings** (`settings.json`) | VPS disk | Small, non-secret. Either commit to git (after Phase 5 decides where it lives) or `scp` periodically. |
| **Code** | GitHub | Already redundant |
| **Env / secrets** | VPS `.env`, Supabase secrets, GitHub secrets | **Document in a password manager** (Bitwarden free, 1Password, etc.). Losing `FRIDAY_SHARED_SECRET` = rotate both sides. Losing `MONGODB_URI` = re-pair. |
| **Logs** | VPS disk + PM2 logrotate | 10 MB rotation, keep ~7 days. Optional: ship to Supabase `bot_logs` table for longer retention (Phase 5). |

**Recovery playbook (if VPS dies):**
1. Provision new Oracle VM (Section E), reserve same IP
2. SSH in, run Section F
3. `git clone` the repo
4. Restore `.env` from password manager
5. `pm2 start ecosystem.config.js && pm2 save && pm2 startup`
6. Bot connects via Mongo auth state — **no re-pairing needed**

---

## 17. Decisions Log (Phase 4)

| # | Decision | Rationale | Date |
|---|---|---|---|
| D46 | Oracle ARM Ampere A1 (1 OCPU / 6 GB) | Fits Always Free, leaves headroom, plenty for bot | 2026-10-31 |
| D47 | Static reserved public IP | Prevents IP drift on restart breaking Atlas whitelist | 2026-10-31 |
| D48 | Ubuntu 22.04 LTS image | Node 20 available, stable, well-documented | 2026-10-31 |
| D49 | Node 20 via NodeSource | Cleaner than nvm for a VPS | 2026-10-31 |
| D50 | PM2 with `max_restarts: 20 / 60s`, `min_uptime: 30s` | Outer safety net; prevents tight crash loops | 2026-10-31 |
| D51 | `pm2-logrotate` installed | Otherwise disk fills in weeks | 2026-10-31 |
| D52 | Deploy via GitHub Actions + `git reset --hard origin/main` | No local hotfix drift; single source of truth | 2026-10-31 |
| D53 | Read-only deploy key on VPS for `git pull`; separate SSH key for GHA | Principle of least privilege | 2026-10-31 |
| D54 | `paths:` filter in GH Actions | Doc-only pushes don't redeploy bot | 2026-10-31 |
| D55 | `pm2 reload` not `restart` in deploy | Zero-downtime if graceful | 2026-10-31 |
| D56 | Mongo Atlas M0 with no backup — recovery = re-pair | M0 has no auto-backups; re-pair is 30 s | 2026-10-31 |
| D57 | Secrets documented in password manager | Losing shared secret = rotate both sides | 2026-10-31 |
| D58 | Plan B: HeavenCloud → AMD micro → paid $3 VPS | Ordered by cost and control | 2026-10-31 |
| D59 | Storage scoped key (C.4) preferred; service key acceptable for MVP | Security hygiene vs. setup time | 2026-10-31 |
| D60 | `ffmpeg` installed on VPS in Phase 4 even if unused until `find`/`transcribe` | Setup once, ready later | 2026-10-31 |

---

## 18. Definition of Done for Phase 4

- [x] Every service setup documented step-by-step
- [x] Every step has a verification
- [x] Order of operations (parallelizable sections identified)
- [x] End-to-end verification checklist
- [x] Troubleshooting table
- [x] Plan B documented
- [x] Cost guardrails documented
- [x] Backup & recovery playbook
- [x] Decisions log (D46–D60)
- [x] Open items: none

**Phase 4 status: COMPLETE.**

---

*Next: `05-first-agent-prompt.md` (Phase 5) — the scoped prompt for the IDE agent to build the framework skeleton.*