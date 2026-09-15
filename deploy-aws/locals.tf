locals {
  name_prefix = var.project_name
  account_id  = data.aws_caller_identity.current.account_id
  partition   = data.aws_partition.current.partition

  # Globally-unique bucket names.
  app_bucket_name   = "${local.name_prefix}-app-${local.account_id}-${var.aws_region}"
  media_bucket_name = "${local.name_prefix}-media-${local.account_id}-${var.aws_region}"

  aliases = var.domain_name == null ? [] : [var.domain_name]

  # The `sub` claim patterns a GitHub Actions token must match to assume a role.
  github_subjects = concat(
    [for branch in var.github_branches : "repo:${var.github_owner}/${var.github_repo}:ref:refs/heads/${branch}"],
    [for environment in var.github_environments : "repo:${var.github_owner}/${var.github_repo}:environment:${environment}"],
    var.github_extra_subjects,
  )

  /*
   * The resource string baked into the CloudFront signed-cookie policy.
   *
   * With a custom domain we know the hostname up front and can scope the policy
   * exactly. Without one, the hostname is the distribution's generated
   * *.cloudfront.net name — and putting that in the Lambda's environment would
   * create a dependency cycle:
   *
   *   lambda (env needs the domain) -> distribution (origin needs the function
   *   URL) -> function URL (needs the lambda)
   *
   * so the host part falls back to a wildcard. That costs nothing in practice:
   * the signature is verified against our public key, our public key lives only
   * in our key group, and that key group is attached only to this distribution.
   * A cookie we signed is therefore useless anywhere else. The path is still
   * pinned to /media/*, which is the part that matters.
   *
   * If you later attach this key group to a second distribution, set
   * domain_name so the policy names one host again.
   */
  media_resource = var.domain_name == null ? "https://*/media/*" : "https://${var.domain_name}/media/*"

  # Shape the roster the way the Lambda expects, dropping nulls.
  users_json = jsonencode([
    for user in var.users : {
      username     = user.username
      name         = coalesce(user.name, user.username)
      roles        = user.roles
      passwordHash = user.password_hash
    }
  ])
}
