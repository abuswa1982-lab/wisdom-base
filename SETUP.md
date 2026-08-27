# Wisdom Base: GitHub to Cloudflare Pages

You push to GitHub like you always do. Cloudflare deploys it by itself.

One setup session, about 30 minutes, almost entirely clicking in the browser.
No terminal. After that, updating the app is just a push, exactly like your
other tools.

---

## What is in this folder

```
index.html                    the app, one file, same as always
functions/api/[[path]].js     the API. Cloudflare runs this automatically.
schema.sql                    the database tables, run once
SETUP.md                      this file
```

The `functions` folder is the only new idea. Cloudflare Pages looks for that
folder name and turns whatever is inside it into your API. You do not deploy
it separately and you do not run anything. It ships with the page.

---

## Step 1: put it on GitHub

New repository, **private**, push these files to it. Same as your other tools.

Keep `index.html` at the top level, not in a subfolder.

## Step 2: connect Cloudflare to the repo

Cloudflare dashboard, **Workers and Pages**, **Create**, **Pages** tab,
**Connect to Git**. Pick the repo.

Build settings:

- Framework preset: **None**
- Build command: **leave empty**
- Build output directory: **/**

Save and deploy. You get a URL like `wisdom-base.pages.dev`.

It works already, but it has no database and no login yet, so it is running in
local mode. Keep going.

## Step 3: the database

Dashboard, **Storage and Databases**, **D1**, **Create database**. Name it
`wisdom-base`.

Open it, go to the **Console** tab, paste the entire contents of `schema.sql`,
run it. That creates the tables.

## Step 4: connect the database to the app

Back in your Pages project: **Settings**, **Bindings**, **Add**, **D1 database**.

- Variable name: `DB` (exactly this, capital D capital B)
- Database: `wisdom-base`

## Step 5: the login

Dashboard, **Zero Trust**, **Access**, **Applications**, **Add an application**,
**Self-hosted**.

- Name: `Wisdom Base`
- Domain: your `pages.dev` URL from step 2
- Policy: Action **Allow**, Include **Emails**, list everyone who should get in.
  Or **Emails ending in** `@yourcompany.com` for the whole company.

Save. Then on the application's page, copy the **Application Audience (AUD) Tag**.

> **Do not skip this.** Preview deployments get their own URLs like
> `abc123.wisdom-base.pages.dev`, and an Access policy on the production
> domain alone does not cover them. In the Access application, add a second
> domain of `*.wisdom-base.pages.dev`, or turn preview deployments off in
> Pages settings. Otherwise there is an unlocked side door.

## Step 6: the settings

Pages project, **Settings**, **Environment variables**, Production. Add:

| Name | Type | Value |
|---|---|---|
| `ADMIN_EMAILS` | Plaintext | `you@company.com,colton@company.com` |
| `ACCESS_TEAM` | Plaintext | your team name, from `<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | Plaintext | the AUD tag you copied in step 5 |
| `ANTHROPIC_KEY` | **Secret** | your Anthropic key |

`ANTHROPIC_KEY` must be **Secret**, not Plaintext. That is what keeps it off
every employee's browser.

## Step 7: redeploy so the settings take

Bindings and variables only apply to a **new** deployment. The one from step 2
does not have them.

Pages project, **Deployments**, latest one, **Retry deployment**.

Or just push any small change to GitHub. Same effect.

## Step 8: check it

Open the URL in a private window. You should get a Cloudflare login, then a
code by email, then the app.

Top right corner should say your email and **ADMIN**.

Then have someone not on the admin list open it. They should see **USER**, with
no Brainstorm and no Admin tab.

If the corner says **LOCAL ONLY**, step 4 or step 7 did not take.

---

## From now on

Edit `index.html`, push to GitHub, done. It is live in about a minute.

Same as your other tools. That was the point of picking this route.

---

## Moving your existing records up

1. Open your local copy, Admin tab, **Export**. You get a `.json`.
2. Open the deployed app, Admin tab, **Import**, pick that file.

Now they are on the server and everyone sees them.

---

## Changing who is an admin

Pages project, Settings, Environment variables, edit `ADMIN_EMAILS`, then
redeploy (step 7).

Removing someone's access entirely is the Access policy in step 5, not this list.

---

## What the server enforces no matter what the browser does

This was tested with real forged tokens, not assumed:

- A request with no token, a garbage token, an expired token, or a token signed
  by someone else gets 401. Nothing else.
- Setting an email header by hand does nothing. The signature is checked
  against Cloudflare's public keys.
- A non-admin is **never sent** draft records. Not hidden, not sent.
- A non-admin write gets 403, even with the tabs forced open in devtools.
- Brainstorm gets 403 for non-admins, so nobody else spends your API credit.
- A record cannot be smuggled in as approved. Anything that is not exactly
  `approved` is stored as draft.
- Duplicate paths are blocked by a database index, not by the form.
- Every save records which email made it.

Anyone signed in can log an unanswered question. That is deliberate. Your
frontline staff finding the gaps is the whole point.

---

## Costs

At your size, almost certainly nothing.

- Pages and Functions free tier: 100,000 requests a day
- D1 free tier: 5 GB
- Cloudflare Access: free up to 50 users
- Anthropic API: only when an admin presses Organize. Reading records is free.

---

## If something breaks

**Corner says LOCAL ONLY.** The `DB` binding is missing, or you have not
redeployed since adding it. Step 4, then step 7.

**Every request says "not signed in".** `ACCESS_TEAM` or `ACCESS_AUD` is wrong.
Check them against the Access application page, then redeploy.

**You see USER but should be ADMIN.** Your email is not in `ADMIN_EMAILS`, or
it differs from the one you logged in with. Compared in lower case.

**Brainstorm says ANTHROPIC_KEY is not set.** It was added to Preview instead
of Production, or as Plaintext instead of Secret. Re-add it and redeploy.

**500 auth check failed.** `ACCESS_TEAM` is wrong, so Cloudflare's public keys
cannot be fetched.

---

## Backups

The database is now the only copy that matters. Once a month, Admin tab,
**Export**, and keep the file somewhere. That is the whole backup.
