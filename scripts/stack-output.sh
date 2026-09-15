#!/usr/bin/env bash
# Prints one CloudFormation stack output. Sourced by the other deploy scripts.
set -euo pipefail
aws cloudformation describe-stacks \
  --region "${AWS_REGION:-us-east-1}" \
  --stack-name "${STACK_NAME:-watcher}" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
  --output text
