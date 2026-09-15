# Watcher

A private video streaming platform — trading education (Harmonic Trading,
Elliott Waves, Smart Money Concepts), cinema and documentaries — served as a
static SPA from S3 through CloudFront, with sign-in required to watch anything.

This is the **MVP**: it runs locally end to end and deploys to AWS from one
Terraform stack. See [docs/ROADMAP.md](docs/ROADMAP.md) for what comes next.

---

## How it works

```
                      ┌──────────────────────────────────────────────┐
  viewer ── HTTPS ──▶ │            one CloudFront distribution        │
                      ├──────────────┬───────────────┬───────────────┤
                      │  default  *  │   /api/*      │   /media/*    │
                      │              │               │  trusted key  │
                      │              │               │  group (gate) │
                      └──────┬───────┴───────┬───────┴───────┬───────┘
                             │               │               │
                      S3 app bucket    Lambda (auth)    S3 media bucket
                      (private, OAC)   Function URL     (private, OAC)
```

Everything is behind **one distribution and one origin**, so there is no CORS
anywhere and cookies just work.

**Access control.** `POST /api/login` checks the password (scrypt) and returns
two things: an HttpOnly JWT session cookie, and a set of **CloudFront signed
cookies** scoped by a custom policy to `/media/*`. CloudFront validates those
signatures at the edge, *before* the cache or the bucket is touched — so an
unauthenticated request for a video segment is rejected at the edge, and the
private buckets are never publicly readable. The signed cookies are short-lived
(1h by default); the SPA renews them in the background so long videos never
stall on an expiry.

**Why it's fast.** The app is a static bundle with hashed filenames cached at
the edge for a year, and the shell is the only thing revalidated. Video is HLS,
so the player adapts bitrate and only fetches the segments it needs, all served
from the edge cache. `hls.js` is a lazily-loaded chunk, so the browse page never
pays for it — the main bundle is ~59 kB gzipped. Safari and iOS play HLS
natively and skip the library entirely.

---

## Run it locally

```bash
npm run install:all        # installs root + web dependencies
npm run art                # generates placeholder poster/backdrop art

npm run dev                # terminal 1 — API + media on :8787
npm run dev:web            # terminal 2 — app on :5173
```

Open http://localhost:5173 and sign in with **`demo` / `demo1234`**
(override with `DEV_USERNAME` / `DEV_PASSWORD`).

The dev server runs the *real* Lambda handler against a throwaway RSA key, so
auth, JWT handling and cookie behaviour are the same code paths as production.
Signature verification is the one thing it does not do — that is CloudFront's
job.

### Adding a video locally

```bash
./scripts/transcode-hls.sh my-lesson.mp4 harmonic-foundations   # needs ffmpeg
```

Then add or update the matching entry in `content/catalog.json`.

---

## Tests

```bash
npm test                   # 31 backend unit tests (auth, JWT, cookie signing)
npm run e2e                # 18 browser tests: sign-in, browse, search, playback
npm run typecheck          # strict TypeScript
```

`npm run e2e` starts both dev servers, records its own video fixture with
Chromium, drives a real browser through the whole app, and cleans up after
itself. Playwright is already a dev dependency; the browser binary is a
one-time download:

```bash
npx playwright install chromium
```

---

## Deploy to AWS

Terraform is the supported path — see **[deploy-aws/README.md](deploy-aws/README.md)**
for the full walkthrough. In short:

```bash
cd deploy-aws
cp terraform.tfvars.example terraform.tfvars   # add viewers + your GitHub repo
node ../scripts/hash-password.mjs              # once per viewer
terraform init && terraform apply              # ~15 min (CloudFront)
terraform output                               # URL + the GitHub repo variables
```

That creates everything: the GitHub OIDC provider and deploy role, both private
buckets, the distribution, the signing key group, and the auth Lambda.

**The domain.** The stack is configured for
**https://watcher.moderndayjourney.me**. Terraform requests the ACM certificate
in us-east-1, writes its validation record into the hosted zone, waits for
issuance, and points A and AAAA aliases at the distribution — DNS is not a
manual step. Credentials come from the `abdul.cloud0two` profile, set as
`aws_profile` in `terraform.tfvars`.

One consequence worth knowing: the signed-cookie policy names that host exactly,
so **video plays on the custom domain only**. The `*.cloudfront.net` address
still loads the app and signs you in, but its segment requests return 403.

Terraform runs from your machine, and only from your machine — no workflow in
this repository runs it. From then on, pushing to `master` is the app
deploy: `.github/workflows/deploy.yml` installs dependencies, builds the SPA,
assumes the OIDC role, syncs to S3 and invalidates CloudFront — with no
long-lived AWS keys stored anywhere.

Backend (`backend/`) changes are the exception: Terraform owns the Lambda
package, so those ship with a local `terraform apply`.

### Day-to-day

```bash
./scripts/upload-content.sh catalog   # publish catalog edits without a full deploy
./scripts/deploy-web.sh               # ship a UI change by hand
```

Both read their targets from `terraform output`, so they need the stack applied
first. Normally you would just push to `master` and let the workflow do it.

To add or remove a viewer, edit the `users` list in `terraform.tfvars` and run
`terraform apply`.

---

## Layout

```
web/          React + TypeScript SPA (Vite)
backend/      Auth Lambda — zero dependencies, node:crypto only
deploy-aws/   Terraform: OIDC, buckets, distribution, key group, Lambda
.github/      CI and OIDC-based deploy workflows
scripts/      Deploy, transcode and local-dev tooling
content/      catalog.json + placeholder art (real video goes to S3)
e2e/          Browser smoke test
docs/         Architecture notes, security notes, roadmap
```

## Security notes

`.secrets/` is gitignored and must stay that way — the private signing key mints
media access for anyone holding it. For the MVP, secrets are passed to Lambda as
environment variables; see [docs/SECURITY.md](docs/SECURITY.md) for what to
harden before this platform takes public traffic.
