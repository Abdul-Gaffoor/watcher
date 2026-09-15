#!/usr/bin/env bash
# Creates the RSA key pair CloudFront uses for signed cookies.
#
#   ./scripts/generate-signing-key.sh
#
# The PUBLIC half goes into the stack (CloudFrontPublicKey parameter).
# The PRIVATE half is a secret — it lets anyone mint media access.
set -euo pipefail

OUT_DIR="${1:-.secrets}"
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

if [[ -f "$OUT_DIR/cloudfront-private.pem" ]]; then
  echo "Refusing to overwrite $OUT_DIR/cloudfront-private.pem" >&2
  exit 1
fi

openssl genrsa -out "$OUT_DIR/cloudfront-private.pem" 2048 2>/dev/null
chmod 600 "$OUT_DIR/cloudfront-private.pem"
openssl rsa -pubout -in "$OUT_DIR/cloudfront-private.pem" -out "$OUT_DIR/cloudfront-public.pem" 2>/dev/null

echo "Wrote $OUT_DIR/cloudfront-private.pem (keep secret, never commit)"
echo "Wrote $OUT_DIR/cloudfront-public.pem  (pass as the CloudFrontPublicKey parameter)"
