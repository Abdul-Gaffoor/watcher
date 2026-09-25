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

**Signing in a television.** `/pair` on the device shows a QR and an eight-character
code; scanning it with a phone that is already signed in opens `/link`, which
names the device and asks. Approving hands the device a session with the
approver's roles. The password is never typed on the television and never
travels to it. Two codes do the work: the short one on screen, which anyone in
the room can read, and a 256-bit device code the device keeps, which the poll
must present — so seeing the screen is not enough to collect the session.
Pairings live ten minutes, work once, and only a hash of the device code is
stored. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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
terraform init && terraform apply              # ~15 min (CloudFront)
terraform output                               # the app URL and bucket names

# The passwords Terraform generated, once:
aws secretsmanager get-secret-value --secret-id watcher/users \
  --query SecretString --output text
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

**Currently running without CloudFront.** AWS gates distribution creation on
accounts it has not verified, and this one is still waiting, so `edge` is set to
`apigateway` in `terraform.tfvars`. An HTTP API serves the same domain with the
same certificate, media is gated by a Lambda that checks the session and hands
back a presigned S3 URL, and nothing is cached. Set `edge = "cloudfront"` and
apply once the account clears. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Pushing to `master` does the whole thing. `.github/workflows/deploy.yml` applies
Terraform first, then publishes the app into the buckets that apply produced,
reading the bucket names and the distribution id from Terraform's outputs rather
than from anything wired up by hand. Backend changes ride along, because
Terraform owns the Lambda package.

State is shared, in `s3://terraform-state-132848804230`, so applying from your
laptop and applying from a push are the same operation on the same resources.
Actions authenticates with an access key pair in the `AWS_ACCESS_KEY` and
`AWS_SECRET_KEY` repository secrets. The viewer roster comes from the tracked
`deploy-aws/terraform.tfvars`, which holds password hashes and is why this
repository is private.

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

## The library, and how videos get into it

The catalog is a tree. A collection names its parent, or nothing at the root,
which is all it takes to hold shelves of different depths side by side:

```
Trading                        Movies
  Elliott Wave                   Telugu
    SweeGlu Elliott Wave Course  Hindi
      the class videos           English
```

A shelf gathers everything beneath it however deep, so the Elliott Wave row on
the home page shows the course's classes without anyone having to file them
twice.

**Uploading is done in the app.** Sign in as an admin and open **Manage**. Pick
a file, name it, choose where it goes. The browser uploads straight to object
storage in 16 MB parts, so a dropped connection costs one part rather than the
whole file, and the catalog is only updated once the video has actually landed.
Nothing passes through the API, because a request body through Lambda is capped
in megabytes and a lesson is gigabytes.

The same screen edits the structure: add a collection anywhere, rename it, move
it, or remove an empty one. Moving takes the whole branch with it, which is how
a category thought of after the courses were created collects them — make
"Trading" at the top level, then set each course's **Inside** to it. A
collection is never offered a destination inside itself, because that would
detach the branch and make a loop of it.

Videos can be renamed and refiled the same way. A rename changes only what a
viewer reads: the id underneath is the storage prefix the video and its poster
already live under, so a name typed wrong at upload is corrected without moving
a byte.

Changes are saved as one document with a revision, so two admins editing at
once get a conflict rather than one silently overwriting the other.

**Only admins see it.** The role rides in the session and is checked on the
server for every request the dashboard makes. Hiding the link is a courtesy,
not the control. Grant it in `deploy-aws/terraform.tfvars`:

```hcl
users = [
  { username = "Abdul", name = "Abdul", roles = ["viewer", "admin"] },
]
```

Two things worth knowing. Uploaded video is served as progressive MP4 rather
than transcoded to an adaptive ladder, so seeking works but quality does not
adapt to a weak connection; `scripts/transcode-hls.sh` still produces HLS if you
want it for a particular title. And the catalog now lives in the media bucket
rather than in git, because a dashboard that could not write it would be a
viewer. The copy in `content/` seeds an empty library and is never republished
over your edits.

## Accounts and MFA

Viewer credentials can live in either of two places, chosen by `auth_provider`
in `deploy-aws/terraform.tfvars`.

`cognito` is the one to be on: a managed user pool with **required MFA**, a
password policy, lockout that survives scale-out, and self-service password
reset. Terraform declares who may sign in and Cognito emails each invitee a
temporary password, so no password or hash is stored in this repository or in
Terraform state. First sign-in walks the viewer through choosing a password and
enrolling an authenticator app, because Terraform can create an account but
cannot enrol a phone for it.

`roster` is a list of viewers in a Secrets Manager secret. Terraform seeds it
with a generated password each and then stops looking at the value, so rotating
a password is editing that secret — no deploy, no commit, and the next
`terraform apply` will not revert it. A change takes effect within a minute
(`roster_ttl_seconds`). It stays as the default because the dev server and the
end-to-end suite must work with no AWS account at all, and because it needs no
verified email address.

Switching, and recovering from a lost authenticator, are both in
[deploy-aws/README.md](deploy-aws/README.md).

## Security notes

No password or password hash is stored in this repository. The roster lives in
Secrets Manager, encrypted with KMS and readable only by the Lambda's role and
whoever you grant `secretsmanager:GetSecretValue` — not by anyone who can read
the function's configuration, which is where it used to sit.

`.secrets/` is gitignored and must stay that way — the private signing key mints
media access for anyone holding it. For the MVP, secrets are passed to Lambda as
environment variables; see [docs/SECURITY.md](docs/SECURITY.md) for what to
harden before this platform takes public traffic.
