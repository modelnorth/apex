# Acknowledgements & Open Source Lineage

**Nod Sovereign** stands on the shoulders of remarkable open-source projects, tools, and protocols. We express our profound gratitude to the creators, maintainers, and developer communities whose work powers this sovereign agent.

---

## 1. Primary Upstream Lineage

### **n8n / Nod** ([n8n-io/nod](https://github.com/n8n-io/nod))
- **Role:** The foundational desktop agent architecture, hexagonal ports, capability ledger, and human-in-the-loop permission flow.
- **Copyright:** (c) 2026 n8n GmbH.
- **License:** Apache License 2.0.
- **Gratitude:** For designing the first truly local-first personal agent architecture and open-sourcing the core engine.

---

## 2. Integrated Open-Source Frameworks & Libraries

### **Vercel Labs — Agent Desktop** ([vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop))
- **Role:** Native OS accessibility tree automation (Windows UI Automation & macOS AX API).
- **License:** MIT License.
- **Impact:** Replaces fragile pixel-based mouse clicking with semantic desktop element inspection and precise OS-level control.

### **Browserbase CLI & Stagehand** ([browserbase/stagehand](https://github.com/browserbase/stagehand))
- **Role:** Resilient browser automation, anti-bot escalation, and headless Chromium execution.
- **License:** MIT License / Apache-2.0.
- **Impact:** Powers stealth web navigation, Cloudflare bypass, and deterministic checkout flows.

### **Playwright** ([microsoft/playwright](https://github.com/microsoft/playwright))
- **Role:** Local headless and headful Chromium browser driver.
- **License:** Apache License 2.0.
- **Impact:** Provides local browser automation without relying on external cloud infrastructure.

### **Fastify** ([fastify/fastify](https://github.com/fastify/fastify))
- **Role:** High-performance, low-overhead HTTP & WebSocket server framework.
- **License:** MIT License.
- **Impact:** Manages high-throughput Twilio voice streaming via WebSocket (`<ConversationRelay>`), inbound SMS webhooks, and local REST APIs.

### **OpenTelemetry (OTel)** ([open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js))
- **Role:** Distributed tracing, GenAI v1.28.0+ semantic conventions, and observability.
- **License:** Apache License 2.0.
- **Impact:** Ensures complete auditability and latency tracking across multi-turn reasoning loops.

### **OwnTracks** ([owntracks/recorder](https://github.com/owntracks/recorder))
- **Role:** Open, private, and self-hosted location tracking and geofencing.
- **License:** GPL-2.0-or-later.
- **Impact:** Enables proactive location triggers without selling user location history to third-party ad networks.

### **TweetNaCl / Node.js Crypto**
- **Role:** Ed25519 asymmetric cryptography and HMAC-SHA1/SHA256 signature verification.
- **Impact:** Powers the zero-trust Agent-to-Agent (A2A) protocol and tamper-proof Twilio webhook authentication.

---

## 3. The ModelNorth Collective

**Nod Sovereign** is curated, hardened, and maintained as a public good by **ModelNorth** (`@modelnorth`), dedicated to advancing sovereign, privacy-preserving AI autonomy.

If you build or innovate on top of Nod Sovereign, please pay it forward: keep personal agents decentralized, auditable, and firmly under human control.
