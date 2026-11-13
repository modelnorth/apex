# Contributing to Apex

Thank you for your interest in contributing to **Apex**, the open-source, self-hosted personal AI operating system curated and maintained by **ModelNorth** (`@modelnorth`).

Everyone participating in this project is expected to uphold our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## 🏛️ Core Principles & Invariants

Apex is designed to be the sovereign alternative to centralized, cloud-hosted AI agents (Instinct AI, Claude Duet, OpenAI Dots). When contributing, keep these four architectural invariants intact:

1. **Local-First & Data Isolation**:
   - Secrets, memory, and personal tokens stay on the user's host or private server.
   - External tools must never receive unscrubbed credentials or private telemetry.
2. **Untrusted Data Boundaries**:
   - All external web content, inbound SMS texts, phone transcripts, and emails must be safely quarantined inside `<untrusted_tool_result>` blocks.
   - Closing tags (`</untrusted_tool_result>`) must be sanitized using regex neutralization to prevent indirect prompt injection.
3. **Hexagonal Architecture**:
   - **Ports (`src/ports/*`)**: Pure TypeScript contracts and domain models. Zero `process.env` reads or vendor SDK imports.
   - **Providers (`src/providers/*`)**: Adapters implementing the port contracts.
   - **Runtime (`src/runtime/*`)**: Orchestrates tools and context.
   - **Server Composition (`src/server/composition.ts`)**: The sole composition root where environment variables are injected.
4. **Deterministic Security Controls**:
   - Virtual card minting and browser checkouts must pass through `PaymentPolicyGuard`.
   - OS automation via GhostDesk OS must uphold execution sandboxing and reject administrative shells (`cmd.exe`, `powershell.exe`, `pwsh`, `bash`).

---

## 🛠️ Local Development Setup

### 1. Prerequisites
- **Node.js**: `v22.0.0` or later (`node -v`)
- **pnpm**: `v9.0.0` or later (`corepack enable && corepack prepare pnpm@latest --activate`)
- **Git**

### 2. Install & Start Development Server
```bash
git clone https://github.com/modelnorth/apex.git
cd apex
pnpm install
cp .env.example .env
pnpm dev
```

---

## 🧪 Testing & Verification Checks

Before submitting a Pull Request, run the automated verification pipeline:

```bash
# 1. Verify Hexagonal Architecture Boundaries
node scripts/check-architecture.mjs

# 2. Strict TypeScript Compilation Check
pnpm exec tsc --noEmit

# 3. Execute Sovereign Capability & Integration Tests
pnpm exec tsx --test tests/sovereign-bundle.test.ts tests/agent-desktop.test.ts tests/inbound-phone-sms.test.ts tests/virtual-card-issuing.test.ts
```

All checks must exit with code `0`.

---

## 📬 Pull Request Guidelines

1. **Title Format**: Follow [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat(ghostdesk): support multi-monitor window focus`
   - `fix(telephony): sanitize inbound webhook phone headers`
   - `docs(readme): add docker deployment walkthrough`
2. **Blast Radius Minimization**: Keep pull requests focused on a single logical change. Avoid combining massive dependency updates with architectural refactors.
3. **Security First**: Never check in API keys, live Stripe credentials, or personal phone numbers.
4. **Docs & Tests**: Include corresponding unit tests in `tests/*.test.ts` and update documentation in `docs/` when introducing new ports or runtime capabilities.

---

## 🔒 Reporting Security Vulnerabilities

If you discover a security vulnerability or prompt injection bypass, please **do not** open a public GitHub issue. Refer to our [Security Policy](SECURITY.md) to report findings privately to the ModelNorth core team.

---

## ⚖️ License & Attribution

Apex is released under the **[Apache License 2.0](LICENSE)**. All contributions submitted to ModelNorth for inclusion in Apex are automatically licensed under the same Apache 2.0 terms. See [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) and [NOTICE](NOTICE) for third-party credits and upstream lineage.
