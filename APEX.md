# Apex Sovereign: The Open-Source Alternative to Instinct AI, Claude Duet & OpenAI Dots

> **"Your AI agent should work for you, on your machine, with your keys, under your rules. Not on a cloud desktop harvesting your data."**

Apex Sovereign (by ModelNorth) transforms the foundational local agent into a full-scale, privacy-first personal AI operating system with real phone calls, single-use virtual burner cards, automated SMS 2FA interception, anti-bot stealth web browsing, native OS accessibility-tree desktop control (GhostDesk OS), and cryptographically signed inter-agent coordination.

---

## 1. Feature Parity & Moat Destruction Matrix

| Capability | Instinct AI | Claude Duet | OpenAI Dots | **Apex Sovereign (ModelNorth)** |
| :--- | :---: | :---: | :---: | :---: |
| **License** | Closed Proprietary | Closed Preview | Closed Alpha | **Apache 2.0 (100% Open Source)** |
| **Data Privacy** | Cloud surveillance; trains models on your screens & chats | Closed cloud indexing | Closed cloud indexing | **100% Local-First & Self-Hosted** |
| **Prompt Injection Defense** | Vulnerable (single-context prompt hijack) | Blackbox filters | Unknown | **Dual-Model Firewall + `<untrusted_tool_result>`** |
| **Outbound Phone Calls** | Proprietary telephony | ❌ None | ❌ None | **Twilio `<ConversationRelay>` (ElevenLabs + Deepgram)** |
| **Inbound Phone & Voice** | Dedicated number | ❌ None | ❌ None | **Twilio Inbound Voice Webhook + WebSocket streaming** |
| **2FA / SMS OTP Interceptor** | Proprietary cloud interceptor | ❌ None | ❌ None | **Twilio Inbound SMS Webhook + Regex OTP Extractor** |
| **Payments & Checkouts** | Blackbox Stripe Link | ❌ None | ❌ None | **Stripe Issuing Burner Cards + Spend Policy Guard** |
| **Web Browsing & Stealth** | Cloud browser | Cloud browser | Cloud browser | **Browserbase Stealth + Auto Anti-Bot Escalation** |
| **Desktop App Automation** | Pixel matching (brittle) | Unknown | Unknown | **GhostDesk OS: Native Accessibility Tree UIA/AX (`@ref` IDs)** |
| **Agent-to-Agent (A2A)** | Closed intra-network | ❌ None | ❌ None | **Ed25519 Signed Canonical JSON Protocol** |
| **Observability** | Hidden telemetry | Closed | Closed | **OpenTelemetry GenAI v1.28.0+ Spans (W3C traceparent)** |
| **Messaging Gateways** | iMessage & WhatsApp | Slack & Web | Slack & Web | **WhatsApp (Baileys), Telegram, and Web Chat** |

---

## 2. Core Architectural Pillars

```
                                 [ USER (Telegram / WhatsApp / Web) ]
                                                  │
                                                  ▼
                                     ┌─────────────────────────┐
                                     │  Dual-Model Safety Wall │
                                     │ (Untrusted Tool Results)│
                                     └────────────┬────────────┘
                                                  │
                ┌───────────────────┬─────────────┴───────┬───────────────────┐
                ▼                   ▼                     ▼                   ▼
       [ Telephony Concierge ]  [ Payments & Cards ]  [ Stealth Web ]    [ OS Desktop ]
         • Outbound Calls        • Spend Policy Guard   • Local Chrome     • Windows UIA
         • Inbound Voice Relay   • Stripe Issuing Cards • Browserbase      • macOS AX
         • 2FA SMS Interceptor   • HITL Checkout Cards  • Turnstile Bypass • Semantic @refs
```

### I. Telephony Concierge & 2FA Interceptor (`src/providers/twilio/`)
* **Outbound Concierge**: Uses Twilio `<ConversationRelay>` with ElevenLabs speech synthesis and Deepgram speech-to-text. Requires mandatory human approval tickets before any outbound phone call is dialed.
* **Inbound Voice**: Answers incoming phone calls conversationally with WebSocket audio streaming.
* **SMS 2FA Auto-Interception**: When merchants or airlines send an SMS 2FA code to your Twilio number, the agent captures the text, extracts the 4-8 digit OTP via regex heuristics, and pipes it directly into the browser or authentication flow.

### II. Spend Policy Guard & Virtual Cards (`src/providers/payments/`)
* **Deterministic Financial Bounds**: Enforces per-transaction limits, rolling 24-hour daily spend caps, and strict merchant origin allowlists.
* **Single-Use Burner Cards**: Integrates with Stripe Issuing to mint temporary Visa debit cards with exact spending caps. Feeds directly into `Computer.fillCard()` for automated checkout while keeping card numbers out of prompt logs.
* **HITL Checkout Handoff**: When a purchase exceeds pre-approved amounts, the agent generates interactive approval cards for WhatsApp, Telegram, or Web.

### III. Stealth Web Automation (`src/providers/browserbase/`)
* Operates local Playwright Chromium for zero-cost routine browsing.
* Automatically detects Cloudflare Turnstile, reCAPTCHA, and bot walls via heuristic classifiers.
* Escalates on-demand to Browserbase with residential proxies and verified anti-detection headers.

### IV. Semantic Desktop Computer Use (`src/providers/desktop/`)
* Uses Vercel Labs' `agent-desktop` to inspect native OS accessibility trees (UIA on Windows, AX on macOS).
* Operates on persistent, stable `@ref` identifiers instead of fragile coordinate guessing or pixel matching.
* Hardened policy sandbox blocks execution of dangerous system shells (`cmd`, `powershell`, `pwsh`, `bash`, `wscript`).

### V. Trusted Inter-Agent Protocol (`src/providers/a2a/`)
* Peer-to-peer agent coordination using Ed25519 digital signatures over canonical RFC 8785 JSON.
* Prevents replay attacks with an in-memory nonce cache and timestamp skew validation.
* Autonomously negotiates overlapping calendar slots and delegates cross-agent tasks.

### VI. Production OpenTelemetry Observability (`src/providers/otlp/`)
* Conforms strictly to OpenTelemetry GenAI Semantic Conventions (v1.28.0+).
* Propagates W3C `traceparent` across subagent boundaries.
* Scrubs sensitive tokens, `op://` references, and Bearer secrets from span attributes.

---

## 3. Quickstart

### Prerequisites
* Node.js v20+ or v24+
* pnpm v9+ or v10+
* Google Chrome or Chromium (e.g. Playwright Chromium)

### Installation
```bash
git clone https://github.com/your-username/nod-sovereign.git
cd nod-sovereign
pnpm install
```

### Run Tests
```bash
pnpm exec tsx --test tests/*.test.ts
```
Expected output: **63 passed, 0 failed, 0 skipped**.

### Start Development Server
```bash
pnpm run dev
```
Open `http://localhost:3000` to start using your sovereign assistant.
