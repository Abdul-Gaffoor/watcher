# Roadmap

The MVP is deliberately small: static catalog, JSON user roster, no database.
These are the things most likely to be wanted next, roughly in the order the
pain usually shows up.

## 1. Content operations

- **Upload pipeline.** Drop an MP4 in a staging bucket, have S3 trigger
  MediaConvert to produce the HLS ladder, then write the catalog entry
  automatically. Replaces `transcode-hls.sh` once uploads are frequent.
- **Thumbnails and sprite sheets** for scrub previews on the progress bar.
- **Catalog authoring.** Editing JSON by hand stops scaling around a hundred
  titles; a small admin page writing to DynamoDB and regenerating the static
  catalog keeps the read path just as fast.

## 2. Accounts

- ~~**Cognito** for sign-up, password reset, MFA and account lockout.~~ **Done**,
  as `auth_provider = "cognito"`. Required MFA made sign-in multi-step, so the
  login page is now a four-step flow: credentials, then whichever challenge the
  pool raises. What is still open on top of it: a QR code on the enrolment
  screen rather than a key to transcribe, recovery codes for a lost phone, and
  Cognito groups wired to the per-genre entitlements below.
- **Server-side watch history**, so resume points follow a viewer across
  devices. `lib/progress.ts` is the only module that changes.
- **Roles and entitlements** — e.g. a trading-only tier that cannot see cinema.
  `roles` already rides in the JWT; the gate would be a per-genre key group or a
  catalog filtered at issue time.

## 3. Player

- Quality selector and playback-speed control (lessons benefit from 1.25×).
- Keyboard shortcuts and a custom control bar.
- Subtitles — the catalog schema and the `<track>` wiring already support them.
- Chapter markers for long lessons.

## 4. Scale and cost

- **Split the catalog per genre** once it is large enough that the browse page
  feels the download; the row components already fetch by genre.
- **CloudFront standard logs** into Athena for watch-time analytics.
- **Origin Shield** if viewers spread across many regions and origin fetches
  start to add up.
- Move to `PriceClass_All` when the audience is genuinely global.

## 5. Hardening

Everything in [SECURITY.md](SECURITY.md) — secrets out of environment
variables, the Function URL locked to CloudFront, and WAF in front of
`/api/login` are the three to do first.
