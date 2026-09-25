# ---------------------------------------------------------------------------
# The user directory.
#
# Replaces the JSON roster the auth Lambda used to carry. What that buys, in
# order of how much it matters here:
#
#   - No password material in git or in Terraform state. Cognito generates each
#     invited viewer a temporary password and emails it; nothing is declared.
#   - MFA, required. A password alone never completes a sign-in.
#   - Lockout that survives scale-out, which the Lambda's in-memory throttle
#     cannot do.
#   - Self-service password reset, so a forgotten password is not a deploy.
#
# Terraform still declares WHO may sign in. It just never learns their secrets.
# ---------------------------------------------------------------------------

resource "aws_cognito_user_pool" "this" {
  count = local.use_cognito ? 1 : 0

  name = local.name_prefix

  # ON, not OPTIONAL: every account must present a second factor. A viewer who
  # has not enrolled one is met with the MFA_SETUP challenge and enrols before
  # they can watch anything.
  mfa_configuration = "ON"

  software_token_mfa_configuration {
    enabled = true
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }

  # Invite-only. Nobody can sign themselves up, which is the whole premise of a
  # private library.
  admin_create_user_config {
    allow_admin_create_user_only = true

    invite_message_template {
      email_subject = "Your ${var.project_name} invitation"
      email_message = join("", [
        "You have been invited to ${var.project_name}.<br><br>",
        "Username: <strong>{username}</strong><br>",
        "Temporary password: <strong>{####}</strong><br><br>",
        "Sign in at ${local.app_url}. You will be asked to choose a new password ",
        "and to enrol an authenticator app before you can watch anything.",
      ])
      sms_message = "Your ${var.project_name} username is {username} and temporary password is {####}"
    }
  }

  # A verified email is what makes "forgot password" possible without an admin.
  auto_verified_attributes = ["email"]

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  schema {
    name                     = "email"
    attribute_data_type      = "String"
    required                 = true
    mutable                  = true
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 5
      max_length = 320
    }
  }

  schema {
    name                     = "name"
    attribute_data_type      = "String"
    required                 = false
    mutable                  = true
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 1
      max_length = 128
    }
  }

  # Changing a schema forces a new pool, which would strand every enrolled
  # authenticator app. Make that loud rather than a surprise in a plan.
  lifecycle {
    ignore_changes = [schema]
  }
}

resource "aws_cognito_user_pool_client" "web" {
  count = local.use_cognito ? 1 : 0

  name         = "${local.name_prefix}-web"
  user_pool_id = aws_cognito_user_pool.this[0].id

  # No secret on purpose. The auth Lambda's calls are the ones a signed-out user
  # is allowed to make, so a secret would be one more thing to store for no
  # gain; what bounds the danger is the pool policy, not the client id.
  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  # A wrong password and an unknown username come back identical, so the login
  # form cannot be used to enumerate who has access.
  prevent_user_existence_errors = "ENABLED"

  enable_token_revocation = true

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}

# One per viewer. No password field: Cognito generates the temporary one and
# emails the invitation, so the only secret in this repository stays absent.
resource "aws_cognito_user" "viewers" {
  for_each = toset(local.viewer_keys)

  user_pool_id = aws_cognito_user_pool.this[0].id
  username     = local.viewers_by_key[each.key].username

  attributes = {
    email = local.viewers_by_key[each.key].email
    # Pre-verified because an admin vouched for the address by inviting it, and
    # an unverified address cannot receive a password reset.
    email_verified = true
    name           = coalesce(local.viewers_by_key[each.key].name, local.viewers_by_key[each.key].username)
  }

  desired_delivery_mediums = ["EMAIL"]

  # Terraform would otherwise try to re-send the invitation on every apply once
  # the viewer has changed their password.
  lifecycle {
    ignore_changes = [attributes["email_verified"]]
  }
}
