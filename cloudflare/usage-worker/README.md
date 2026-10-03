# SilkStack usage endpoint

The Cloudflare Worker behind SilkStack's anonymous usage ping. The whole
server side of the feature is this folder; the whole client side is
[`electron/usagePing.mjs`](../../electron/usagePing.mjs).

One POST per active install per day, from the **packaged app only** (dev runs
send nothing). The question it answers: *how many installs are active, and in
which countries* — split by free / trial / pro.

## What arrives, what is stored

| Field  | Meaning                                                                |
| ------ | ---------------------------------------------------------------------- |
| `id`   | random install ID (UUID v4), generated locally on first run           |
| `v`    | app version                                                             |
| `os`   | `win32` / `darwin` / `linux`                                            |
| `plan` | `free`, `pro` or `trial` — `trial` while a membership's free week is still running |

Each request becomes one Analytics Engine data point:

- `index1` — the install ID (the count-distinct slot)
- `blob1` — country, from `request.cf.country`; the IP is derived by the edge
  and **never read, logged or stored** by this Worker
- `blob2` — app version
- `blob3` — OS
- `blob4` — plan

Never sent by the app and never stored here: license key, license e-mail, file
or folder names, image counts, prompts, tags, search queries. The install ID
is random, never derived from hardware or the license, and rotates whenever
the app's data folder is reset.

## Deploy

Prerequisites: a Cloudflare account, and the `workers.dev` subdomain
registered (happens on the first Worker creation in the dashboard).

```powershell
npx wrangler login      # once, opens the browser
npx wrangler whoami     # sanity check; prints your Account ID
npx wrangler deploy     # from this folder — creates/updates the Worker
```

`name` in `wrangler.jsonc` must stay `silkstack` (the URL is
`https://silkstack.ksaravanakumar.workers.dev/`). If the account has never used
Analytics Engine, `wrangler deploy` may refuse until it is enabled — create a
blank dataset in the dashboard (Workers & Pages → Analytics Engine) named
`silkstack_usage`; leave the binding alone, it is declared in `wrangler.jsonc`
(`SILKSTACK_USAGE` → `silkstack_usage`) and set by the deploy. Otherwise the
dataset is created **automatically on the first write** — nothing to provision.

Smoke test (this creates the dataset):

```powershell
Invoke-RestMethod -Method Post -Uri https://silkstack.ksaravanakumar.workers.dev/ `
  -ContentType 'application/json' `
  -Body '{"id":"test-1","v":"2.3.0","os":"win32","plan":"free"}'
```

Then open **Workers & Pages → Analytics Engine → `silkstack_usage`** — the
data point appears within a minute or two.

## Queries

Two ways in — the SQL below is identical either way:

1. **Dashboard** — Workers & Pages → Analytics Engine → `silkstack_usage`: if
   that page offers a query/SQL box, paste the queries below into it.
2. **SQL API** (the documented path) — create an API token with
   **Account | Account Analytics | Read** (My Profile → API Tokens → Create
   Custom Token) and get your Account ID from `npx wrangler whoami`, then:

```powershell
$token   = "<API_TOKEN>"
$account = "<ACCOUNT_ID>"
Invoke-RestMethod -Method Post `
  -Uri "https://api.cloudflare.com/client/v4/accounts/$account/analytics_engine/sql" `
  -Headers @{ Authorization = "Bearer $token" } `
  -Body "SELECT * FROM silkstack_usage ORDER BY timestamp DESC LIMIT 10"
```

`SHOW TABLES` confirms the dataset exists; `FORMAT JSON` and the rest of the
dialect are in the [SQL API docs](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/).

Free tier: 100k writes and 10k queries per day, **90-day retention** (snapshot
monthly aggregates elsewhere if you ever want lifetime numbers).

```sql
-- Monthly active installs
SELECT count(DISTINCT index1) AS installs
  FROM silkstack_usage
 WHERE timestamp > NOW() - INTERVAL '30' DAY;

-- Daily active installs, last 14 days
SELECT toDate(timestamp) AS day, count(DISTINCT index1) AS installs
  FROM silkstack_usage
 WHERE timestamp > NOW() - INTERVAL '14' DAY
 GROUP BY day ORDER BY day;

-- Where from
SELECT blob1 AS country, count(DISTINCT index1) AS installs
  FROM silkstack_usage
 GROUP BY country ORDER BY installs DESC;

-- Free vs trial vs pro
SELECT blob4 AS plan, count(DISTINCT index1) AS installs
  FROM silkstack_usage
 GROUP BY plan;

-- Installs seen in their free trial, last 30 days. (For conversion, count
-- installs whose plan changed trial → pro — group by index1 over the window.)
SELECT count(DISTINCT index1) AS trial_installs
  FROM silkstack_usage
 WHERE blob4 = 'trial' AND timestamp > NOW() - INTERVAL '30' DAY;

-- Version adoption
SELECT blob2 AS version, count(DISTINCT index1) AS installs
  FROM silkstack_usage
 GROUP BY version ORDER BY installs DESC;
```

`count(DISTINCT index1)` is exact at this volume; Analytics Engine only
samples at high write rates, where the weighted form
`count(DISTINCT index1) * SUM(_sample_interval) / COUNT()` becomes the
estimator.

## Notes

- The endpoint is public by design: anything shipped inside a desktop app is
  extractable, so there is no secret. The Worker validates the payload shape
  and ignores everything else.
- If a ping is ever abused, add a Cloudflare rate-limiting rule on the route;
  at this scale it is not worth a code change.
- The Worker's test lives at
  [`src/__tests__/usage-worker.test.ts`](../../src/__tests__/usage-worker.test.ts)
  and runs with the app's root `npx vitest run`.
