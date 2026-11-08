# SAVAGE VPS CREATOR

Private Telegram control bot for Fly.io Machines. Owner IDs are configured in `OWNER_IDS`.

## Important architecture

This ZIP contains the Telegram control bot only. It is not itself a general-purpose SSH VPS image. The bot must run as a separate Fly.io app (`savage-vps-creator-bot`), while managed VPS Machines belong to the separate app named by `FLY_APP_NAME` (for example `savage-vps-fleet`).

Before creating Machines:
1. Create the managed Machines app in your Fly.io organization.
2. Build and deploy an SSH-enabled Linux image that you control.
3. Ensure the image installs the supplied `SSH_AUTHORIZED_KEY` as an authorized public key for a non-root account, starts `sshd`, and applies a secure firewall.
4. Configure public IP/networking separately. A private Machine address is not automatically reachable from the public internet.
5. Test with one small Machine and check Fly.io billing before provisioning more.

Fly.io does not automatically issue a traditional root password. This project is designed around SSH public-key authentication. Keep the matching private key in Termius only.

## Setup

Requirements: Node.js 20+.

```bash
npm install
cp .env.example .env
```

Set these environment variables in your deployment secrets, not in source control:
- `BOT_TOKEN`: a newly generated BotFather token. Revoke any token previously pasted into chat.
- `FLY_API_TOKEN`: Fly.io API token. Keep private.
- `OWNER_IDS`: `7532448669,7094344384`
- `FLY_APP_NAME`: existing app that will contain the managed Machines.
- `VPS_IMAGE`: your own SSH-enabled image.
- `SSH_AUTHORIZED_KEY`: Termius public key, never the private key.

Run locally with `npm start`.

## Deploy bot app

Create the bot app `savage-vps-creator-bot` in the `free-fire-733` organization, then set secrets using `fly secrets set` and deploy with `fly deploy`. Do not commit `.env`.

## Billing and security

Fly.io resources can incur charges. Confirm current pricing and organization billing with a parent or guardian before provisioning. Keep API tokens and private SSH keys out of Telegram messages, GitHub, and chat.
