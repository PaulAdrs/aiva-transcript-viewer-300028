# AIVA Call Transcript Viewer (template)

Static page (GitHub Pages) + Cloudflare Worker backend. A user enters an
access code and a conversation ID, the Worker fetches the transcript +
paired tool-call (name/arguments/result) events from the AIVA admin portal
(**prod**), scoped to a single company you choose.

**This talks to real production data (real caller PII: names, phone
numbers, and whatever the agent's tools capture).** That's why there's an
access-code gate and a company-scope check — read "Notes / limits" below
before sharing this with anyone.

This is a template: it has no live secrets or deployed endpoints baked in.
Each person who uses it deploys their **own** Worker, under their **own**
Cloudflare account, seeded with their **own** cached admin-portal token, and
picks their **own** access code and company ID.

## 1. Deploy the Worker

```bash
cd worker
npx wrangler login                     # opens a browser, log in to YOUR Cloudflare account
npx wrangler kv namespace create TOKENS
```

Copy the `id` it prints into `wrangler.toml` (replace
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`).

In `worker/src/index.js`, set `ALLOWED_COMPANY_ID` to the company you're
scoping this to (replace `REPLACE_WITH_YOUR_COMPANY_ID`).

Seed the KV store with your currently-cached **prod** admin-portal token
(same shape as used by the `admin-portal-login` skill: `id_token`,
`access_token`, `refresh_token`, `expires_at`, `env`, `domain`, `client_id`):

```bash
npx wrangler kv key put --binding=TOKENS "prod" --path="$HOME/.aiva/admin-portal-prod.json" --remote
```

Set the shared access code that whoever you send the link to will need to
enter (pick your own value):

```bash
npx wrangler secret put ACCESS_CODE
```

Deploy:

```bash
npx wrangler deploy
```

This prints your Worker URL, e.g. `https://aiva-transcript-viewer.<your-subdomain>.workers.dev`.

The Worker auto-refreshes the token using the cached refresh token, so you
don't need to re-seed it until the refresh token itself expires (~30 days
of inactivity).

## 2. Point the site at the Worker

Edit `site/index.html`, replace `REPLACE_WITH_YOUR_WORKER_URL` with the URL
from step 1. Give whoever needs this both the page URL and the access
code (send the code via a separate channel, e.g. a different message than
the link itself).

## 3. Publish the site to GitHub Pages

```bash
cd ../site
git init
git add index.html
git commit -m "Add transcript viewer"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

Then in the repo settings on GitHub: **Settings → Pages → Deploy from branch
→ main → / (root)**. GitHub gives you the public URL
(`https://<your-username>.github.io/<repo-name>/`) after a minute.

Anyone with the link and access code can look up any conversation ID
belonging to the company you set in step 1 — nothing else.

## Notes / limits

- The access code is basic protection, not real auth — anyone who has it
  can query any conversation ID belonging to your chosen company. Treat it
  like a shared password: don't post it anywhere public alongside the
  link, and rotate it (`wrangler secret put ACCESS_CODE` again) if you
  suspect it leaked.
- Delete the Worker (`npx wrangler delete`) and take down the GitHub Pages
  repo once it's no longer needed — don't leave real customer call data
  reachable indefinitely.
- If the Worker ever returns "No cached token in KV", re-seed it (your
  local admin-portal token file must be fresh — re-run your admin-portal
  login flow if needed).
- Before pointing this at a new company, double check with whoever owns
  that client relationship that sharing transcripts this way (a single
  shared access code, not per-recipient auth) is acceptable for their data
  — don't assume "just testing" means no real PII is involved.
