<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# PrePaid

---

## 1. What this project is

**PrePaid** lets someone set up recurring USDC payments on **Arc mainnet** without giving anyone a standing approval and without depositing funds anywhere.

Mental model: **post-dated cheques**. The payer signs a set of future payments in one sitting. Each payment is locked to one payee, one amount, and one time window. Anyone can trigger a payment once its window opens, and the trigger-er earns a small tip, so no company has to run a server. The payer's money stays in their wallet until the moment each payment executes. One transaction cancels every remaining payment.

It is built on **EIP-3009** (off-chain signed USDC transfers): `transferWithAuthorization`, `receiveWithAuthorization`, `cancelAuthorization`.

### Hackathon constraints (these drive every decision)
- This is an entry for **Arc Microgrants**. Submissions close **Oct 14, 2026, 23:59 ET**. Target submitting by **Oct 12**.
- Must be **deployed and working on Arc mainnet** (testnet-only does not count), with a public repo, a live link, and a short description of what it uses Arc for.
- Reviewers weigh: relevance to Arc, technical credibility, quality of what was built, promise. Not traction.
- **A small thing that works end-to-end on mainnet beats a large thing that is half done.** Prefer cutting scope over cutting tests or the mainnet demo.

**Hackathon Details Link** - https://dorahacks.io/hackathon/arc-microgrants/detail

---

# 2. Documentation - Arc Docs

- https://docs.arc.io/
- https://docs.arc.io/integrate/relayers-and-paymasters/eip-3009-relayer

**YOU ARE COMPLETELY ALLOWED TO SEARCH DOCS OTHER THAN THIS FROM THE INTERNET YOU CAN SEARCH FOR WHATEVER DOCS YOU WANT FROM THE INTERNET THIS LINKS ARE PROVIDED FOR YOUR REFERENCE AND EASE**

# 3. Tech stack 

- **Contracts:** Hardhat + TypeScript, Solidity (see §9 for version), OpenZeppelin.
- **Frontend:** Next.js (App Router) + TypeScript + **viem** (wagmi allowed for wallet connection).
- **Relayer:** a plain Node/TypeScript script using viem (no framework).
- **No database.** The contract is the source of truth. Do not add Supabase, Postgres, Redis, etc.
- Package manager: **pnpm** 



