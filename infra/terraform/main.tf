# Jarvis "brain" tunnel — Cloudflare Zero Trust Tunnel + Access, as IaC.
#
# Purpose: give the ISOLATED Lima VM `agente` (brain Jarvis: Hermes agents +
# routing) a secure INTERNET ingress WITHOUT putting it on the LAN and WITHOUT
# opening any inbound port. cloudflared dials OUTBOUND from the VM to the
# Cloudflare edge; the apollo Worker reaches the brain at a hostname locked by
# a Cloudflare Access service token. Mac is not in the path. LAN isolation of
# the VM is preserved by construction (the VM's only peer is the CF edge).
#
# Provider v5, CI-only (PR->plan, merge->apply), R2-backed state — mirrors the
# talvi/relay projects. Token read from CLOUDFLARE_API_TOKEN env (GH Actions
# secret sourced from Bitwarden); never set here. See README.md.

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3"
    }
  }

  # Remote state on R2 (S3-compatible). AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
  # come from GH Actions secrets (Bitwarden). Bucket must exist before first
  # apply (see README). Separate key from talvi/relay state, deliberately.
  backend "s3" {
    bucket = "apollo-tfstate"
    key    = "apollo-brain/terraform.tfstate"
    region = "auto"
    endpoints = {
      s3 = "https://a5164131e929a177af583d60f4c6dc47.r2.cloudflarestorage.com"
    }
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

# Token read from CLOUDFLARE_API_TOKEN automatically — never set here.
provider "cloudflare" {}

variable "cloudflare_account_id" {
  type        = string
  description = "GH Actions var CLOUDFLARE_ACCOUNT_ID"
}

# Zone id for ygdcbtmc4u.uk (same zone talvi/relay use). GH Actions VARIABLE,
# not a secret — a zone id is an identifier, useful to read in a plan diff.
variable "cloudflare_zone_id" {
  type        = string
  description = "GH Actions var APOLLO_ZONE_ID (zone ygdcbtmc4u.uk)"
}

variable "brain_hostname" {
  type        = string
  default     = "brain.ygdcbtmc4u.uk"
  description = "Public hostname the apollo Worker calls; fronts the VM brain."
}

# Where cloudflared forwards inside the VM. The Hermes brain API must listen
# on this local address (localhost only — never 0.0.0.0 exposed).
variable "brain_local_service" {
  type    = string
  default = "http://localhost:8080"
}

# 32-byte tunnel secret, base64. Kept in state (sensitive); the VM authenticates
# with the computed `.token`, not this directly.
resource "random_id" "tunnel_secret" {
  byte_length = 32
}

# The named tunnel. config_src = "cloudflare" => ingress is managed remotely by
# the _config resource below (no credentials file on the VM; the VM runs
# `cloudflared tunnel run --token <token>`).
resource "cloudflare_zero_trust_tunnel_cloudflared" "brain" {
  account_id    = var.cloudflare_account_id
  name          = "jarvis-brain"
  tunnel_secret = random_id.tunnel_secret.b64_std
  config_src    = "cloudflare"
}

# The run token for the VM's cloudflared. In provider v5 this is a data
# source, not an attribute of the tunnel resource.
data "cloudflare_zero_trust_tunnel_cloudflared_token" "brain" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.brain.id
}

# Ingress: the brain hostname -> the VM's local Hermes API. Catch-all 404 is
# required as the last rule.
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "brain" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.brain.id
  config = {
    ingress = [
      {
        hostname = var.brain_hostname
        service  = var.brain_local_service
      },
      {
        service = "http_status:404"
      },
    ]
  }
}

# DNS: brain.ygdcbtmc4u.uk -> the tunnel. Proxied (orange cloud) so Access +
# the tunnel can terminate at the edge.
resource "cloudflare_dns_record" "brain" {
  zone_id = var.cloudflare_zone_id
  name    = "brain"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.brain.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

# Service token the apollo Worker presents (CF-Access-Client-Id / -Secret
# headers). This is the ONLY principal allowed to reach the brain — an open
# hostname would be a public internet API.
resource "cloudflare_zero_trust_access_service_token" "worker" {
  account_id = var.cloudflare_account_id
  name       = "apollo-worker-to-brain"
}

# Access policy: non-identity, allow only that one service token.
resource "cloudflare_zero_trust_access_policy" "brain_svc" {
  account_id = var.cloudflare_account_id
  name       = "allow-apollo-worker-token"
  decision   = "non_identity"
  include = [
    {
      service_token = {
        token_id = cloudflare_zero_trust_access_service_token.worker.id
      }
    },
  ]
}

# Access application guarding the brain hostname; binds the policy above.
resource "cloudflare_zero_trust_access_application" "brain" {
  account_id       = var.cloudflare_account_id
  name             = "jarvis-brain"
  domain           = var.brain_hostname
  type             = "self_hosted"
  session_duration = "24h"
  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.brain_svc.id
      precedence = 1
    },
  ]
}

# --- Outputs (all sensitive; copy into Bitwarden, then into the VM/Worker) ---

# The VM's cloudflared runs: cloudflared tunnel run --token <tunnel_token>
output "tunnel_token" {
  value     = data.cloudflare_zero_trust_tunnel_cloudflared_token.brain.token
  sensitive = true
}

# The apollo Worker sends these two as CF-Access-Client-Id / CF-Access-Client-Secret.
output "access_client_id" {
  value     = cloudflare_zero_trust_access_service_token.worker.client_id
  sensitive = true
}

output "access_client_secret" {
  value     = cloudflare_zero_trust_access_service_token.worker.client_secret
  sensitive = true
}

output "brain_url" {
  value = "https://${var.brain_hostname}"
}
