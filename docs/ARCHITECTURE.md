# Architecture

## Why a single CloudFront distribution

The app, the API and the video all sit behind one distribution, separated by
cache behaviours rather than by hostname:

| Path | Origin | Cache | Gate |
| --- | --- | --- | --- |
| `/api/*` | Lambda Function URL | disabled | session JWT (in the handler) |
| `/media/*` | media bucket (OAC) | CachingOptimized | **trusted key group** |
| everything else | app bucket (OAC) | CachingOptimized | none (public shell) |

Consequences worth knowing:

- **No CORS anywhere.** Same origin means cookies are sent on API calls, on
  `catalog.json`, and on every HLS segment without any preflight.
- **No cookie-domain juggling.** One host, so `SameSite=Lax` is enough.
- **One TLS handshake and one connection** for the shell, the API and the video,
  multiplexed over HTTP/2 or HTTP/3.

## The fallback front end

CloudFront cannot be created on an account AWS has not verified, and that check
sits on `CreateDistribution` alone. `edge = "apigateway"` in `terraform.tfvars`
swaps the distribution for an HTTP API on the same domain, with the same
certificate and the same buckets:

| Path | Integration | Gate |
| --- | --- | --- |
| `/api/*` | the auth Lambda, unchanged | session JWT, in the handler |
| `/media/*` | the edge Lambda | session JWT, then a presigned S3 URL |
| everything else | the edge Lambda | none (public shell) |

The auth Lambda needs no changes at all: API Gateway's payload format 2.0 is the
same event shape a Function URL sends, down to the `cookies` array in both
directions.

**Media is gated in code rather than at an edge.** There is no key group to
trust, so the edge Lambda verifies the session itself and then hands back a
302 to a presigned S3 URL that expires on the same clock the cookies would
have. The bucket is never public; the URL carries its own signature.

**Playlists are served inline, segments are redirected.** A player resolves the
names inside a `.m3u8` against the URL it was finally fetched from. Redirecting
a playlist to S3 would rebase every segment onto an unsigned S3 URL, so the
playlist stays on this origin and only its segments redirect. That redirect is
what makes the media bucket need a CORS rule: the request starts same-origin
and finishes cross-origin.

**What this costs.** Everything, cached nowhere. Each asset and each video
segment is a Lambda invocation plus an S3 read in one region, for every viewer,
every time. It is a way to be live, not a way to serve video well, and
`edge = "cloudfront"` is a one-line change back once the account is verified.

## Notes

Notes share the collection tree with videos, as a sibling array rather than a
kind of title — almost nothing they carry is the same, since a note has no
duration, no poster and no playback position.

```
catalog.json (version 3)
  collections[]   the tree, unchanged
  titles[]        videos
  notes[]         { id, title, collectionId, format, source, original? }
```

Adding them bumped the catalog to version 3, and the upgrade from 2 is a
default rather than a rewrite: an empty `notes` array. That is the reason for
a sibling array over a `kind` field on titles — every catalog already written
stays valid.

Files live under `media/notes/<id>/`, one folder per note, so a note and
anything converted from it are deleted together. The key is derived from the
note id and re-derived on the server for every upload, exactly as a video's
is; `isOwnedMediaKey` guards both prefixes.

`.docx` is converted to HTML in the admin's browser before it is stored,
because no browser renders one. It is sanitised then *and* again when it is
rendered — the store is not a trust boundary, and storing something we would
refuse to display is how a latent problem is made. Markdown is parsed at read
time so the stored file stays the thing that was written.

Content type matters more here than for video: a PDF served as
`application/octet-stream` downloads instead of opening, and markdown served
as `text/html` would execute. It is set on the presigned PUT, so S3 serves
each note with the type it was stored under.

### Writing one: a rich editor over a plain format

The in-app editor is TipTap (ProseMirror), which works in HTML. What it saves
is Markdown, converted on the way out with turndown. The asymmetry is
deliberate:

- Markdown is what survives. It is readable without this app, it diffs like
  text, and every feature the toolbar offers has a GitHub-flavoured spelling.
  The editor's own HTML would tie each note to whichever editor was installed
  the day it was written.
- Turndown covers most of it, and four things it does not: strikethrough,
  checklists (`- [x]`), tables, which it flattens into a paragraph, and
  collapsible sections. A table is one of the reasons to have a rich editor at
  all, so all four are written out by hand in `note-editing.ts`.
- A note already stored as HTML — anything converted from a `.docx` — stays
  HTML when edited. Rewriting somebody's imported document into another format
  behind their back is not an upgrade.
- A PDF is a picture of a document. `isEditable` refuses it, and the entry
  points are not shown for one.

Images pasted or chosen in the editor go to `media/notes/<id>/asset-<slot>.<ext>`
through the same presigned single PUT as a poster. The slot is a token the
client generates and the server checks against a pattern; it is never a
filename, because a filename in a key is somebody else's path traversal. SVG is
refused — an SVG is a script that draws.

A note being written needs an id before it is saved, because an image dropped
into it is stored under that id. The page settles one on mount and keeps it, so
a draft's images and the saved note agree. The id itself comes from the title
when it is first saved, and never changes after: it is the URL and the storage
prefix, so a rename moves no bytes.

### Collapsible sections

Markdown has no syntax for one, so what is stored is the HTML it allows:
`<details>` with a `<summary>`, a blank line, the body as Markdown, a blank
line, `</details>`. The blank lines end the HTML block, which is what makes the
body parse as Markdown in any renderer rather than come through as text.

Three ProseMirror nodes, not one: `details` holding a `detailsSummary` (one
line, no marks — that is what a summary is) and a `detailsContent` (anything,
including another section). The ready-made TipTap extension for this is a paid
Pro one; these are about eighty lines.

In the editor a section renders as a `div`, not a `<details>`. A real one
collapses when its summary is clicked, and a section that can collapse out from
under the cursor is a section that cannot be edited. It becomes a `<details>` on
the way to storage, and a reader gets the native element with its own keyboard
handling and find-in-page behaviour.

`normaliseDetails` in `lib/markdown.ts` puts the body wrapper in on the way in,
for the same reason the checklist reconciliation is there: deciding where an
implicit wrapper belongs is the DOM parser's least reliable job, and doing it
once by hand is cheaper than finding out which browser disagrees.

The editor is ~145 kB gzipped and loads as its own chunk, behind `/write` and
`/notes/<id>/edit`. Nobody reading a note pays for it.

## Pairing a device

RFC 8628 (the OAuth device grant) in miniature, for screens where typing a
password is awkward or public.

```
television                      phone (already signed in)
  POST /api/device/start
    └─▶ userCode  NTWS-D5XN      shown on screen, and in the QR
        deviceCode  32 bytes     kept; never displayed
                                  GET  /api/device/pending?code=NTWS-D5XN
                                    └─▶ "Chrome on a TV, from 203.0.113.7"
                                  POST /api/device/decide  { approve: true }
  POST /api/device/poll
    { userCode, deviceCode } ───▶ watcher_session, as the approver
```

The split between the two codes is the security. The short one is public to
anyone who can see the screen; the long one is what the poll must present, so
an onlooker who reads the code off a television cannot collect the session that
the approval produces. Only `sha256(deviceCode)` is stored, so a dump of the
table cannot be replayed into a pending sign-in.

A pairing lives ten minutes and is deleted the moment it is collected, so one
approval is one session. Approval is a conditional write against `status =
pending`, which is what makes "approve twice" and "approve after collection"
impossible rather than merely unlikely. Unknown, used and expired codes all get
the same answer, so the endpoint is not an oracle for which codes are live.

Pairings wait in a DynamoDB table with a TTL attribute. DynamoDB sweeps
expired rows on its own schedule and can be hours late, so every read compares
the timestamp itself; the TTL only keeps the table from growing.

## Access control

```
POST /api/login
  ├── scrypt-verify against the roster in Secrets Manager (cached 60s)
  ├── sign an HS256 JWT  ──────────────▶  watcher_session   (HttpOnly, 12h)
  └── sign an RSA-SHA1 CloudFront policy ▶ CloudFront-Policy
                                           CloudFront-Signature   (HttpOnly, 1h)
                                           CloudFront-Key-Pair-Id
```

The CloudFront cookies use a **custom policy** scoped to
`https://<domain>/media/*` — not the whole distribution — with an explicit
expiry. CloudFront verifies the signature against the public key in the trusted
key group at the edge, so an unauthorised segment request never reaches S3 and
never populates the cache.

The two lifetimes are deliberately different. The session outlives the media
cookies, so the SPA can silently re-issue media access (`POST /api/refresh`)
without asking for the password again. `AuthProvider` schedules that refresh
five minutes before expiry, and the catalog fetch retries once through a
refresh if it ever sees a 403.

### Why signed cookies rather than signed URLs

An HLS stream is hundreds of segment URLs generated by the player at runtime.
Signing each one would mean rewriting every manifest per viewer per session,
which breaks edge caching — every viewer would get a cache miss. Cookies are
signed once, apply to every segment, and leave the objects perfectly cacheable
and shared across all viewers.

## Caching strategy

Cache headers are set at upload time; the managed `CachingOptimized` policy
honours them.

| Object | `Cache-Control` | Why |
| --- | --- | --- |
| `/assets/*` (hashed) | `max-age=31536000, immutable` | filename changes on every build |
| `index.html` | `no-cache, must-revalidate` | points at the hashed bundles |
| HLS segments, artwork | `max-age=31536000, immutable` | a re-encode gets a new path |
| `*.m3u8` | `max-age=300` | playlists can be rewritten |
| `catalog.json` | `max-age=60` + invalidation | changes most often, tiny |

Only `index.html` and `catalog.json` are ever invalidated, which keeps
deployments inside the free invalidation tier.

## SPA routing

`/watch/abc` is a client-side route with no object behind it. The usual fix —
`CustomErrorResponses` mapping 403/404 to `/index.html` — is **distribution-wide**,
so it would also rewrite the 403 that CloudFront returns for expired media
cookies into a 200 with HTML, breaking the refresh path and confusing `hls.js`.

Instead a CloudFront Function on the default behaviour rewrites any path whose
last segment has no dot to `/index.html`. It runs only on the app behaviour, so
`/media/*` and `/api/*` return their real status codes.

## Bundle shape

`hls.js` is ~186 kB gzipped — larger than the rest of the app combined. It is
pinned to its own chunk and loaded with a dynamic `import()` inside the player,
so it is fetched only when a viewer opens a title, and never on the browse page.
Safari and iOS play HLS natively and skip the download entirely.

The same rule applies to everything else that is only wanted occasionally: the
note editor (~145 kB), the `.docx` converter (~126 kB), the Markdown parser and
the sanitiser are all dynamic imports. The entry chunk is ~83 kB gzipped, and
the browse page loads that and nothing else.

## Catalog as a static file

The catalog is a single JSON file in the media bucket, behind the same signed
cookies as the video. No database, no API call, no cold start — it is served
from the edge cache like any other asset, and publishing an update is one
`aws s3 cp` plus one invalidation.

This holds comfortably into the low thousands of titles. Past that, split it per
genre or move search server-side — see [ROADMAP.md](ROADMAP.md).

## The Lambda has no dependencies

JWT signing, scrypt hashing and the CloudFront RSA-SHA1 policy signature are all
implemented directly on `node:crypto`. The deployment package is a handful of
`.mjs` files, so cold starts are minimal and there is no dependency tree to
audit or patch on an endpoint that handles passwords.
