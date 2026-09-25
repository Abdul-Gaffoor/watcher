# ---------------------------------------------------------------------------
# Where a QR pairing waits between the television asking and the phone saying
# yes. Seconds of life, written once and read every two seconds by a poll.
#
# DynamoDB rather than the media bucket, which holds everything else that is
# state here. S3 is a good home for the catalog and a bad one for this: a poll
# every two seconds against an object that was just overwritten is the exact
# access pattern S3 handles worst, and there is no conditional write to make
# "approve only if still pending" safe.
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "devices" {
  name = "${local.name_prefix}-device-pairings"

  # Pay per request. This table sees a handful of writes a week and idles the
  # rest of the time; provisioned capacity would be billing for nothing.
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "user_code"

  attribute {
    name = "user_code"
    type = "S"
  }

  # DynamoDB deletes expired rows on its own schedule, sometimes many hours
  # late. This keeps the table from growing, and is not the expiry check --
  # the handler compares the timestamp itself on every read, because a row
  # that is merely still present must still behave as gone.
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  point_in_time_recovery {
    # Nothing here outlives ten minutes. Backing it up would be paying to keep
    # codes that were already worthless when the snapshot was taken.
    enabled = false
  }

  server_side_encryption {
    enabled = true
  }
}
