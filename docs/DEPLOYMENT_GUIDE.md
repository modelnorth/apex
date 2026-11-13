# Apex Sovereign: Deployment & Operations Guide

This guide details how to self-host and run **Apex Sovereign** (by ModelNorth) 24/7 as an autonomous personal intelligence operating system with zero reliance on centralized proprietary clouds (Instinct AI, Claude Duet, OpenAI Dots).

---

## 1. System Requirements

### Hardware
- **VPS / Home Server**: 2 vCPU, 4GB RAM minimum (8GB recommended if running local browser automation with Playwright/Chromium).
- **Disk**: 20GB SSD for logs, OTel traces, and Playwright session profiles.
- **Operating System**: Ubuntu 22.04+ LTS, Debian 12+, macOS Sonoma+, or Windows 11 / Windows Server 2022.

### Software Prerequisites
- **Node.js**: v20.0.0 or v22.0.0+ LTS
- **pnpm**: v9.0.0+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- **Git**: For versioning and automated pull updates.
- **Optional**: Cloudflare Tunnel (`cloudflared`) or ngrok for webhook ingress (Twilio, OwnTracks).

---

## 2. Environment Configuration

Clone the repository and copy the environment template:

```bash
git clone https://github.com/modelnorth/apex-sovereign.git
cd apex-sovereign
cp .env.example .env
```

Edit `.env` with your preferred sovereign providers:

```bash
# Core Server & Security
PORT=3000
NODE_ENV=production
SOVEREIGN_ADMIN_TOKEN=your-random-32-byte-hex-secret
APEX_PUBLIC_URL=https://sovereign.yourdomain.com

# LLM Providers (Select Anthropic or Gemini)
ANTHROPIC_API_KEY=sk-ant-api03-...
# GEMINI_API_KEY=AIzaSy...

# Inbound & Outbound Telephony / SMS 2FA (Twilio)
TWILIO_ACCOUNT_SID=ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=+1234567890
CONCIERGE_APPROVED_CALLER_NUMBER=+1987654321

# Browserbase Cloud Anti-Bot Automation (Optional fallback from local Playwright)
BROWSERBASE_API_KEY=bb_live_...
BROWSERBASE_PROJECT_ID=proj_...

# Virtual Burner Card Issuing (Stripe Issuing)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_ISSUING_CARDHOLDER_ID=ich_...

# Spending Policy Limits
APEX_SPEND_PER_TRANSACTION_LIMIT_CENTS=10000 # $100.00
APEX_SPEND_DAILY_LIMIT_CENTS=25000           # $250.00
APEX_SPEND_HITL_THRESHOLD_CENTS=5000         # $50.00 triggers confirmation

# Agent-to-Agent (A2A) Cryptographic Identity
APEX_A2A_PRIVATE_KEY_HEX=your_ed25519_seed_hex_32_bytes
APEX_A2A_PEER_ID=apex-node-alpha

# OpenTelemetry Tracing (Optional: Honeycomb, SigNoz, Datadog)
OTEL_SERVICE_NAME=apex-sovereign
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=your_key
```

---

## 3. Webhook Ingress Setup (Twilio & SMS 2FA)

Twilio requires an HTTPS webhook endpoint to route inbound voice calls and SMS OTPs to your sovereign node.

### Option A: Cloudflare Tunnel (Recommended & Free)
1. Install `cloudflared`:
   ```bash
   sudo apt-get install cloudflared
   ```
2. Authenticate and create a tunnel:
   ```bash
   cloudflared tunnel create apex-agent
   cloudflared tunnel route dns apex-agent sovereign.yourdomain.com
   ```
3. Run the tunnel routing traffic to your local port:
   ```bash
   cloudflared tunnel run --url http://localhost:3000 apex-agent
   ```

### Option B: Twilio Console Configuration
In your Twilio Console (Phone Numbers > Manage > Active Numbers):
- **Voice & Fax**: Set "A Call Comes In" to `Webhook` -> `POST` -> `https://sovereign.yourdomain.com/webhooks/twilio/voice`
- **Messaging**: Set "A Message Comes In" to `Webhook` -> `POST` -> `https://sovereign.yourdomain.com/webhooks/twilio/sms`

All incoming SMS messages (containing 2FA codes from Delta, Google, Banks, Uber) will be automatically intercepted, cryptographically validated with Twilio's HMAC-SHA1 signature, parsed with regex heuristics, and queued in memory for runtime tools (`wait_for_sms_otp`).

---

## 4. Production Process Management

### Running with systemd (Linux VPS)
Create `/etc/systemd/system/apex-sovereign.service`:

```ini
[Unit]
Description=Apex Sovereign Autonomous Operating System
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/apex-sovereign
EnvironmentFile=/home/ubuntu/apex-sovereign/.env
ExecStart=/usr/bin/pnpm start
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable apex-sovereign
sudo systemctl start apex-sovereign
sudo journalctl -u apex-sovereign -f
```

---

## 5. Security & Isolation Invariants

1. **Untrusted Tool Boundaries**:
   All external contents from `stealth_browse`, inbound SMS, and email are enclosed in `<untrusted_tool_result>` blocks. The agent prompt treats these tags as untrusted data, preventing indirect prompt injection.
2. **Spend Policy Guard**:
   Every virtual card minting attempt and automated browser checkout passes through `PaymentPolicyGuard`. Transactions exceeding daily limits or single-use violations are halted instantly.
3. **Desktop Launch Sandbox**:
   The desktop integration only executes whitelisted applications (`chrome`, `brave`, `calc`, `notepad`, etc.) and rejects shell metacharacters (`[&|;><$`\n\r\t\0\\/]`).

---

## 6. Verification & Health Check

Verify your deployment and run full test suites locally or on the target server:

```bash
# Check architectural boundaries
node scripts/check-architecture.mjs

# Verify TypeScript compilation
pnpm exec tsc --noEmit

# Run all 63 unit and end-to-end integration tests
pnpm test
```
