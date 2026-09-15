variable "project_name" {
  type        = string
  default     = "watcher"
  description = "Must match the parent stack's project_name."
}

variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "Region for the state bucket."
}
