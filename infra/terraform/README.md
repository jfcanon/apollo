# Jarvis brain tunnel — IaC

Cloudflare Zero Trust Tunnel + Access that gives the **isolated** Lima VM
`agente` a secure internet ingress with **no inbound ports** and **no LAN
exposure**. cloudflared dials outbound from the VM; the apollo Worker reaches
the brain at `https://brain.ygdcbtmc4u.uk`, locked by an Access service token.
Latency: Cloudflare Tunnel terminates at the home's nearest PoP (no relay hop)
— per the `jarvis-tunnel-arch` Quorum verdict, ~tens of ms, 1–3% of a voice
turn. The Mac is never in the path.

## Where the Cloudflare secrets live (do NOT hardcode)

Same model as talvi/relay (see project CLAUDE.md): `relay/.secrets.env` maps
names to Bitwarden items; values live in Bitwarden and flow to GitHub Actions.
This project needs, as **GitHub Actions repo secrets/vars** on `jfcanon/apollo`:

| Kind | Name | Source |
|---|---|---|
| secret | `CLOUDFLARE_API_TOKEN` | Bitwarden item `clouflareapitoken` (as talvi/relay). Needs Account:Cloudflare Tunnel:Edit, Account:Access:Edit, Zone:DNS:Edit on `ygdcbtmc4u.uk` |
| secret | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | R2 state creds (Bitwarden, as talvi) |
| var | `CLOUDFLARE_ACCOUNT_ID` | GH Actions var (as talvi) |
| var | `APOLLO_ZONE_ID` | zone id for `ygdcbtmc4u.uk` (identifier, not a secret) |

One-time before first apply: create the R2 state bucket **`apollo-tfstate`**
(console or `wrangler r2 bucket create apollo-tfstate`). The Terraform CI never
runs locally.

## Apply flow (CI only — never `terraform apply` locally)

Mirrors talvi/relay `terraform.yml`: **PR → `terraform plan`**, **merge to main
→ `terraform apply`**. Wait on the apply matching your own HEAD sha.

1. Put `terraform.yml` at `.github/workflows/terraform.yml` (provided here as
   `infra/terraform/terraform.yml`; move it — it scopes `working-directory` to
   `infra/terraform`).
2. PR the `infra/terraform/**` files → read the plan.
3. Merge → apply creates: the tunnel, its ingress config, the DNS record, the
   Access app + policy + service token.

## After apply — capture the outputs into Bitwarden, then wire the two ends

All outputs are `sensitive`. From the apply job (or `terraform output -raw`):

- `tunnel_token` → Bitwarden item `jarvis-brain-tunnel-token`.
- `access_client_id` + `access_client_secret` → Bitwarden item
  `jarvis-brain-access-token`.

### VM side (brain) — cloudflared as a service
cloudflared is already installed in the VM (`/tmp/cloudflared`, 2026.8.1; move
to `/usr/local/bin`). Run it with the tunnel token (outbound only — isolation
intact):

```bash
# in the VM (limactl shell agente):
sudo install -m0755 /tmp/cloudflared /usr/local/bin/cloudflared
sudo cloudflared service install <TUNNEL_TOKEN>   # from Bitwarden; runs as a systemd unit
# the Hermes brain API must listen on http://localhost:8080 (see brain_local_service)
```

### Worker side (caller) — present the service token
The apollo Worker calls `https://brain.ygdcbtmc4u.uk` with headers
`CF-Access-Client-Id: <access_client_id>` and
`CF-Access-Client-Secret: <access_client_secret>` (both `wrangler secret put`,
from Bitwarden). A missing/invalid token → Access denies at the edge; the brain
is never a public API.

## Trust boundaries (from the Quorum verdict)
① ESP32↔Worker: existing per-device secret. ② Worker↔brain: **this** Access
service token (new principal, separate store). ③ VM interior: Hermes binds
localhost only; the tunnel maps one hostname → one local port. ④ VM↔LAN: **none
— isolation intact by construction.** Home-device control is a SEPARATE
LAN-connected box (future mini-PC), never this isolated brain.

## Not here (deliberately)
- Home controller (Hue/cameras) — needs LAN egress; a second, LAN-connected
  tunnel on the mini-PC, its own service token. Sequenced after the mini-PC
  exists (do not retire the Mac's Hue reach before then).
- The Worker's brain-proxy route code — a follow-up PR on the apollo Worker.
