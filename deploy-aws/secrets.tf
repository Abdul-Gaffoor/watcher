# ---------------------------------------------------------------------------
# The viewer roster, as a rotatable secret.
#
# It used to be a Lambda environment variable holding scrypt hashes, which was
# wrong twice over. An environment variable is not a secret — anyone with
# lambda:GetFunctionConfiguration reads it back in plaintext, and the console
# prints it. And changing a password meant running a hashing script, editing a
# tfvars file, committing it and waiting for a deploy, which is the kind of
# friction that means a password never actually gets changed.
#
# Now Terraform creates the secret and seeds it once with a generated password
# per user, then stops looking at the value. Rotating is editing the secret —
# in the console, the CLI, or by a rotation Lambda later — and the next sign-in
# a minute later uses the new password. No deploy, and nothing to commit.
# ---------------------------------------------------------------------------

# One per user, so rotating one viewer does not disturb another. These land in
# Terraform state, which is the S3 backend rather than git; they are a starting
# password, meant to be replaced by the first rotation.
resource "random_password" "seed" {
  for_each = local.use_cognito ? {} : local.seed_keys

  length = 24
  # Excluded rather than allowed: a password that has to survive being read off
  # a console, pasted into a form and possibly read aloud should not contain
  # characters that are ambiguous in a proportional font or awkward in a shell.
  override_special = "!#%*+-=?_"
}

resource "aws_secretsmanager_secret" "users" {
  count = local.use_cognito ? 0 : 1

  name        = "${local.name_prefix}/users"
  description = "Viewer roster for ${var.project_name}. Edit to rotate a password; no deploy needed."

  # Secrets Manager holds a deleted secret for a recovery window, during which
  # the name cannot be reused. Zero means tearing the stack down and standing
  # it back up works, which matters more here than undeleting a roster of one.
  recovery_window_in_days = var.users_secret_recovery_days
}

# The seed only. `ignore_changes` is the whole point: without it the next apply
# would revert whatever you rotated to, and rotation would be a lie.
#
# To deliberately reseed from Terraform — a forgotten password with no console
# access, say — untaint this by replacing it:
#   terraform apply -replace='aws_secretsmanager_secret_version.users[0]'
resource "aws_secretsmanager_secret_version" "users" {
  count = local.use_cognito ? 0 : 1

  secret_id     = aws_secretsmanager_secret.users[0].id
  secret_string = local.users_seed_json

  lifecycle {
    ignore_changes = [secret_string]
  }
}
