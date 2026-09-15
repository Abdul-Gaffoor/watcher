#!/usr/bin/env bash
# Creates or updates the CloudFormation stack.
#
#   STACK_NAME=watcher ./scripts/deploy-infra.sh
#
# Expects .secrets/cloudfront-public.pem (see generate-signing-key.sh) and a
# .secrets/users.json roster built with hash-password.mjs.
set -euo pipefail

STACK_NAME="${STACK_NAME:-watcher}"
PROJECT_NAME="${PROJECT_NAME:-watcher}"
REGION="${AWS_REGION:-us-east-1}"
SECRETS_DIR="${SECRETS_DIR:-.secrets}"
PRICE_CLASS="${PRICE_CLASS:-PriceClass_100}"
TEMPLATE="infra/cloudformation/watcher-stack.yaml"

PUBLIC_KEY_FILE="$SECRETS_DIR/cloudfront-public.pem"
USERS_FILE="$SECRETS_DIR/users.json"
SESSION_SECRET_FILE="$SECRETS_DIR/session-secret.txt"

for file in "$PUBLIC_KEY_FILE" "$USERS_FILE"; do
  [[ -f "$file" ]] || { echo "Missing $file" >&2; exit 1; }
done

# Generated once and reused, so redeploying does not sign everyone out.
if [[ ! -f "$SESSION_SECRET_FILE" ]]; then
  openssl rand -base64 48 | tr -d '\n' > "$SESSION_SECRET_FILE"
  chmod 600 "$SESSION_SECRET_FILE"
  echo "Generated a new session secret at $SESSION_SECRET_FILE"
fi

# Built as a file rather than inline Key=Value pairs: the roster JSON contains
# commas and the public key contains newlines, both of which the shorthand form
# mangles.
PARAMS_FILE="$(mktemp)"
trap 'rm -f "$PARAMS_FILE"' EXIT

PROJECT_NAME="$PROJECT_NAME" PRICE_CLASS="$PRICE_CLASS" \
PUBLIC_KEY="$(cat "$PUBLIC_KEY_FILE")" \
SESSION_SECRET="$(cat "$SESSION_SECRET_FILE")" \
USERS_JSON="$(cat "$USERS_FILE")" \
node -e '
  const users = JSON.parse(process.env.USERS_JSON);
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error("users.json must be a non-empty array");
  }
  for (const user of users) {
    if (!user.username || !user.passwordHash) {
      throw new Error("each user needs a username and a passwordHash");
    }
    if (!String(user.passwordHash).startsWith("scrypt$")) {
      throw new Error(`passwordHash for "${user.username}" is not a scrypt hash — use scripts/hash-password.mjs`);
    }
  }
  const parameters = {
    ProjectName: process.env.PROJECT_NAME,
    PriceClass: process.env.PRICE_CLASS,
    CloudFrontPublicKey: process.env.PUBLIC_KEY,
    SessionSecret: process.env.SESSION_SECRET,
    UsersJson: JSON.stringify(users),
  };
  process.stdout.write(JSON.stringify(
    Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
  ));
' > "$PARAMS_FILE"

echo "Deploying stack '$STACK_NAME' to $REGION…"
aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file "$TEMPLATE" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "file://$PARAMS_FILE"

echo
aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue}' \
  --output table

echo
echo "Next: ./scripts/deploy-api.sh && ./scripts/deploy-web.sh && ./scripts/upload-content.sh"
