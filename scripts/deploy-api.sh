#!/usr/bin/env bash
# Packages and uploads the auth Lambda, then wires in the two settings that
# could not be set at stack-creation time (the signing private key, and the
# media resource string, which needs the distribution domain).
#
#   ./scripts/deploy-api.sh
set -euo pipefail

STACK_NAME="${STACK_NAME:-watcher}"
REGION="${AWS_REGION:-us-east-1}"
SECRETS_DIR="${SECRETS_DIR:-.secrets}"
PRIVATE_KEY_FILE="$SECRETS_DIR/cloudfront-private.pem"

[[ -f "$PRIVATE_KEY_FILE" ]] || { echo "Missing $PRIVATE_KEY_FILE" >&2; exit 1; }

FUNCTION_NAME="$(./scripts/stack-output.sh ApiFunctionName)"
MEDIA_RESOURCE="$(./scripts/stack-output.sh MediaResource)"

BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

# The handler has no dependencies, so "packaging" is just zipping the sources.
cp backend/src/*.mjs "$BUILD_DIR/"
(cd "$BUILD_DIR" && zip -q -r api.zip ./*.mjs)

echo "Uploading code to $FUNCTION_NAME…"
aws lambda update-function-code \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://$BUILD_DIR/api.zip" \
  --output text --query 'LastModified'

aws lambda wait function-updated --region "$REGION" --function-name "$FUNCTION_NAME"

echo "Applying runtime configuration…"
# Merge into the existing variables rather than replacing them, so the values
# CloudFormation owns (users, secrets, TTLs) survive.
EXISTING="$(aws lambda get-function-configuration \
  --region "$REGION" --function-name "$FUNCTION_NAME" \
  --query 'Environment.Variables' --output json)"

MERGED="$(EXISTING="$EXISTING" \
  PRIVATE_KEY="$(cat "$PRIVATE_KEY_FILE")" \
  MEDIA_RESOURCE="$MEDIA_RESOURCE" \
  node -e '
    const vars = JSON.parse(process.env.EXISTING || "{}");
    vars.CLOUDFRONT_PRIVATE_KEY = process.env.PRIVATE_KEY;
    vars.MEDIA_RESOURCE = process.env.MEDIA_RESOURCE;
    process.stdout.write(JSON.stringify({ Variables: vars }));
  ')"

aws lambda update-function-configuration \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --environment "$MERGED" \
  --output text --query 'LastModified'

aws lambda wait function-updated --region "$REGION" --function-name "$FUNCTION_NAME"
echo "API deployed. Media resource: $MEDIA_RESOURCE"
