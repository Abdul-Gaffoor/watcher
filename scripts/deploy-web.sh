#!/usr/bin/env bash
# Builds the SPA and syncs it to the app bucket with cache headers that make
# CloudFront fast: hashed assets immutable for a year, the shell never cached.
#
#   ./scripts/deploy-web.sh
set -euo pipefail

STACK_NAME="${STACK_NAME:-watcher}"
REGION="${AWS_REGION:-us-east-1}"

APP_BUCKET="$(./scripts/stack-output.sh AppBucketName)"
DISTRIBUTION_ID="$(./scripts/stack-output.sh DistributionId)"

echo "Building the web app…"
(cd web && npm ci && npm run build)

echo "Syncing hashed assets to s3://$APP_BUCKET…"
aws s3 sync web/dist "s3://$APP_BUCKET" \
  --region "$REGION" \
  --delete \
  --exclude 'index.html' \
  --cache-control 'public, max-age=31536000, immutable'

# index.html carries the references to the hashed bundles, so it must always be
# revalidated — otherwise a deploy is invisible until the edge TTL lapses.
echo "Uploading index.html…"
aws s3 cp web/dist/index.html "s3://$APP_BUCKET/index.html" \
  --region "$REGION" \
  --cache-control 'no-cache, must-revalidate' \
  --content-type 'text/html; charset=utf-8'

echo "Invalidating the app shell…"
aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" \
  --paths '/index.html' '/' \
  --output text --query 'Invalidation.Id'

echo "Web deployed: https://$(./scripts/stack-output.sh DistributionDomainName)"
