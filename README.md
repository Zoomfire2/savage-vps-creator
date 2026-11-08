# ⚡ SAVAGE VPS CREATOR

Telegram bot that deploys **real, SSH-ready Ubuntu VPS machines on Fly.io** and manages them (start / stop / restart / SSH details / delete). Nothing is simulated: every VPS is a Fly Machine + Volume, with a verified public IP and SSH port.

## How it works
- **Create VPS** → *Default plans* (6) or *Custom* (RAM → CPU → Storage → OS → Region). Everything is validated against Fly.io limits first; unsupported configs are **refused with an explanation**, never silently downgraded.
- On confirm the bot: ensures an app public IP (allocates one via Fly GraphQL if missing) → picks a free external TCP port → creates a Volume (storage) → creates the Machine with the exact CPU/RAM → waits until `started` → **checks the SSH banner on `ip:port`**. Any failure rolls everything back and nothing is reported as deployed.
- Credentials (`root` + random 24-char password, hashed before reaching Fly) are sent in a private, non-forwardable message. Passwords are stored AES-256-GCM-encrypted in machine metadata so **🔐 SSH DETAILS** can show them again to the owner only.
- Ownership is stored in machine metadata (`savage_owner`); every action re-checks it.

## Fly.io limits that apply (so some plans cannot exist)
| Limit | Value |
|---|---|
| vCPU per Machine | 1, 2, 4, 8, 16 |
| RAM per Machine | up to 128 GB (shared: ≤2 GB/vCPU, performance: 2–8 GB/vCPU) |
| Volume | 1–500 GB |

Default plans: 1–3 work. **Plan 4 & 5 (12 vCPU)** are not valid sizes — the bot offers an explicit "use 16 vCPU instead" button. **Plan 6 (512 GB / 96 vCPU / 720 GB)** exceeds every Fly.io limit and is reported as unavailable. Your org may have lower quotas; Fly's rejection message is shown as-is.

*Storage* = a persistent Fly Volume mounted at `/data`. The root disk comes from the image and is not resized.

## Setup
1. Create the fleet app: `fly apps create savage-vps-fleet`
2. Build/push the SSH image(s) in `vps-image/` (see its Dockerfile header). Set `VPS_IMAGE_2404` / `VPS_IMAGE_2204` (existing `VPS_IMAGE` still works as Ubuntu 24.04).
3. Deploy the bot (separate app): 
   ```
   fly secrets set BOT_TOKEN=... FLY_API_TOKEN=... FLY_APP_NAME=savage-vps-fleet VPS_IMAGE=... CREDENTIAL_SECRET=$(openssl rand -hex 24)
   fly deploy
   ```
4. Add other users with `ALLOWED_USER_IDS` (owners are built in). Each user only sees their own VPS.

See `.env.example`. **Costs:** shown as estimates before confirm; a dedicated IPv4 (~$2/mo) is used (`PUBLIC_IP_TYPE=v6` for free IPv6). Machines/volumes bill until deleted.

## Notes
- Passwords are SHA-512-hashed in the Machine env; the plaintext lives only in the encrypted metadata blob. Changing `CREDENTIAL_SECRET` makes old passwords unrecoverable (key login/root change still works).
- Fly's `fly.toml` no longer has an HTTP service so the polling bot is never auto-stopped.
- Run tests: `npm test` (uses a local mock of the Fly API).
