#!/usr/bin/env bash
# Prints one Terraform output from the deploy-aws stack.
# Sourced by deploy-web.sh and upload-content.sh.
#
#   ./scripts/stack-output.sh app_bucket_name
set -euo pipefail

STACK_DIR="${STACK_DIR:-deploy-aws}"

if [[ ! -d "$STACK_DIR/.terraform" ]]; then
  echo "No initialised Terraform state in $STACK_DIR." >&2
  echo "Run: (cd $STACK_DIR && terraform init && terraform apply)" >&2
  exit 1
fi

VALUE="$(terraform -chdir="$STACK_DIR" output -raw "$1" 2>/dev/null || true)"

if [[ -z "$VALUE" ]]; then
  echo "Terraform output '$1' is empty or missing. Has the stack been applied?" >&2
  exit 1
fi

printf '%s\n' "$VALUE"
