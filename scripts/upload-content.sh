#!/usr/bin/env bash
# Syncs content/ into the media bucket.
#
#   ./scripts/upload-content.sh              # everything
#   ./scripts/upload-content.sh catalog      # just the catalog (fast iteration)
#
# Segments and artwork are immutable — a re-encode gets a new path — so they are
# cached hard at the edge. The catalog is small and changes often, so it gets a
# short TTL plus an invalidation.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
MODE="${1:-all}"

MEDIA_BUCKET="$(./scripts/stack-output.sh media_bucket_name)"
DISTRIBUTION_ID="$(./scripts/stack-output.sh distribution_id)"

upload_catalog() {
  echo "Uploading catalog…"
  aws s3 cp content/catalog.json "s3://$MEDIA_BUCKET/media/catalog.json" \
    --region "$REGION" \
    --cache-control 'public, max-age=60' \
    --content-type 'application/json; charset=utf-8'

  aws cloudfront create-invalidation \
    --distribution-id "$DISTRIBUTION_ID" \
    --paths '/media/catalog.json' \
    --output text --query 'Invalidation.Id'
}

upload_media() {
  echo "Syncing media to s3://$MEDIA_BUCKET…"
  # Playlists must be revalidated (they can be rewritten); segments never change.
  aws s3 sync content/media "s3://$MEDIA_BUCKET/media" \
    --region "$REGION" \
    --exclude '*.m3u8' \
    --cache-control 'public, max-age=31536000, immutable'

  aws s3 sync content/media "s3://$MEDIA_BUCKET/media" \
    --region "$REGION" \
    --exclude '*' --include '*.m3u8' \
    --cache-control 'public, max-age=300' \
    --content-type 'application/vnd.apple.mpegurl'
}

case "$MODE" in
  catalog) upload_catalog ;;
  media) upload_media ;;
  all) upload_media; upload_catalog ;;
  *) echo "Usage: $0 [all|media|catalog]" >&2; exit 1 ;;
esac

echo "Content uploaded."
