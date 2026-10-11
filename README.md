PrePaid lets users plan recurring USDC payments on Arc. The frontend uses
Next.js, and the smart contract uses signed USDC transfer authorizations.

## Getting Started

### Preview the payment UI

Run `pnpm dev` from the repository root and open `http://localhost:3000`.
The form supports a recipient, payment amount, optional tip, first payment
date/time, and daily, weekly, or monthly intervals. End a schedule after
1–50 payments or on a chosen date. The live preview and review dialog show
dates and exact USDC totals. All dates use your device's local timezone;
monthly payments keep the original day and adjust for shorter months.

The wallet button connects through RainbowKit and wagmi on Arc testnet.
It shows the connected address, opens account/disconnect controls, and offers
network switching when the wallet is on another chain. Set your Reown project
ID in `.env.local` as `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (see
`.env.local.example`), then restart `pnpm dev`. Add your app's deployed domain
to your project's allowed origins in the [Reown dashboard](https://dashboard.reown.com/).

Review a plan, then choose **Sign & save**. The wallet first signs a sign-in
message if needed, followed by one USDC `ReceiveWithAuthorization` per payment.
Completed signatures are verified and saved together in PostgreSQL. **My
payments** loads saved schedules for your authenticated wallet, including
dates, amounts, tips and recorded statuses. It survives refreshes.

Each occurrence opens at its displayed time and expires 24 hours later,
capped at the next occurrence. EIP-3009 expiry is exclusive. Signing and
saving send no transaction and require no deposit or approval. If saving
fails, keep the tab open and use **Retry saving**; the same schedule ID and
signatures are reused. Unsaved signatures are held only in memory, so
refreshing loses them. A declined signing request uploads no partial schedule.

Add `PREPAID_CONTRACT_ADDRESS` to `.env.local` using the **current database-based
contract deployment**. The existing `deployments/arc-testnet.json` predates
that redesign; do not assume its address supports this flow. Before signing,
the server checks the chain, nonce commitment, token, tip split, decimals and
USDC domain against the configured deployment. Phase 1 supports Arc testnet.
Set `APP_ORIGIN` to your app's exact origin (for example,
`http://localhost:3000` locally or `https://your-app.example` when hosted).
Production requires this setting. `ARC_RPC_URL` optionally overrides the
server RPC. Restart the app after environment changes.

Wallet connection alone grants no database access: sign-in uses a five-minute
single-use [SIWE message](https://github.com/wevm/viem/blob/main/src/utils/siwe/createSiweMessage.ts),
then an eight-hour HttpOnly session with a rotated opaque token. Only its
hash is stored. APIs enforce matching origins for writes and derive the payer
from this session. Payment messages use the
[documented Arc USDC domain](https://docs.arc.io/integrate/relayers-and-paymasters/eip-3009-relayer).
Cancellation controls and relayer execution are separate phases. Displayed
statuses are database bookkeeping, not a new live receipt indexer.

Check the UI with `pnpm lint`, `pnpm exec tsc --noEmit`, and
`pnpm exec tsx --test app/schedule.test.ts`.

### Neon PostgreSQL setup

The database uses **Postgres.js** (`postgres`) with parameterized SQL.
The Node.js app backend and future relayer share `lib/db/`; no ORM or
separate database package is required. Database functions are server-only.
The app uses server-only API routes to authenticate wallets and save/load
schedules. Transaction broadcasting remains the relayer's responsibility.

1. Create a Neon project/database (or use your existing one). Choose a region
   close to the app/relayer hosting. Copy the **pooled PostgreSQL connection
   URL** from Neon's Connect dialog.
2. Prepare the environment file from the repository root:

   ```powershell
   Copy-Item .env.local.example .env.local
   ```

   If `.env.local` already exists, add the example variables to that file
   instead of overwriting it. Replace the placeholder `DATABASE_URL` using
   your editor. Keep the URL private; never put it in a `NEXT_PUBLIC_`
   variable or paste it into chat. Remote connections require TLS with
   certificate verification. `DATABASE_POOL_MAX=3` caps connections per
   Node process; Neon pooling also handles connections across instances.
3. Install dependencies and create the tables:

   ```powershell
   pnpm install
   pnpm db:migrate
   pnpm db:check
   ```

   Success prints the newly applied migration filenames, then confirms
   the tables. In Neon SQL Editor you will see `prepaid_schedules`,
   `prepaid_payments`, `prepaid_wallet_sessions` and `prepaid_migrations`.
   The script creates structures but does not seed payments or send chain
   transactions. Run it again safely: applied migrations are skipped.
4. Run local verification without Neon credentials:

   ```powershell
   pnpm db:test
   pnpm exec tsc --noEmit
   ```

   The test-only PGlite dependencies start embedded PostgreSQL over a local
   TCP socket so tests exercise the **actual Postgres.js driver and SQL**.
   They never use `DATABASE_URL`, deploy a contract, or touch Neon.
   This embedded server is not a replacement for verifying concurrent
   relayers against Neon/PostgreSQL in the final deployment.

Commands use Node.js **22.13+**, load `.env.local`, and enable the
`react-server` condition so shared `server-only` modules can run in CLI
scripts. Next.js loads `.env.local` itself. For a hosting environment that
injects variables and has no local env file, run
`pnpm exec tsx --conditions=react-server scripts/db-migrate.ts` directly.
Future relayer scripts importing this repository also need that condition.

#### Database files and query interface

| File | Purpose |
| --- | --- |
| `lib/db/client.ts` | Lazy shared Node.js connection pool, TLS, connection limits and cleanup. |
| `lib/db/authorization.ts` | JSON-safe payment types, instruction validation, nonce generation, EOA signature verification and contract payload conversion. Safe to import for wallet signing; contains no database credentials. |
| `lib/db/payments.ts` | Server-only shared repository for app backend and relayers. |
| `db/migrations/001_payments.sql` | Tables, exact integer/hex constraints, uniqueness and discovery indexes. |
| `db/migrations/002_wallet_sessions.sql` | Wallet sign-in challenges and hashed session tokens. Run `pnpm db:migrate` again for an existing database. |
| `app/api/auth/route.ts` | Wallet challenge, verification, session lookup and logout. |
| `app/api/schedules/route.ts` | Authenticated, validated schedule uploads and paginated dashboard reads. |
| `app/api/payments/config/route.ts` | Read-only chain, deployed contract and USDC domain verification. |
| `lib/payments.ts` / `app/use-payments.ts` | Browser authorization preparation, wallet signing and upload retry. |
| `lib/db/migrate.ts` | Checksummed, transactional migration runner with a transaction-scoped advisory lock. |
| `scripts/db-migrate.ts` / `scripts/db-check.ts` | Table creation and connection/schema checks. |
| `lib/db/payments.test.ts` | PostgreSQL integration tests without a hosted database. |

Amounts, tips, block numbers and authorization timestamps are **decimal
strings** in the repository's JSON-facing values. Do not convert them to
JavaScript `number`. Use six-decimal USDC units; `toContractPayment(key,
payment)` converts amounts/windows to `bigint` for viem.
`chainId` is a supported Arc network ID, not an unrestricted large integer.
Every schedule is scoped by chain, deployed PrePaid address, payer and a
random nonzero bytes32 schedule ID. Each occurrence has its own random salt.

Use `createPaymentRepository()` from a Node.js Server Component, Route
Handler, authenticated backend service or CLI. Existing pages remain a UI
preview and do not yet call these functions.

| Method | Use |
| --- | --- |
| `saveSchedule({ ...key, payments, label?, metadata? })` | Verify and atomically store 1–50 signed occurrences. Retries with the same ordered instructions return the existing schedule; changing signed instructions is rejected. Existing labels/metadata are retained on retries. |
| `getSchedule(key)` / `listPayerSchedules(context, payer, limit?, offset?)` | Payer schedule/history queries, scoped to the deployment. |
| `listSchedulePayments(key)` | Read a schedule's full payment payloads and bookkeeping. |
| `listDuePayments(context, chainTimestamp, limit?)` | Read-only relayer-page discovery; does not reserve work. |
| `claimDuePayments(context, chainTimestamp, workerId, limit?, leaseSeconds?)` | Atomically lease up to 50 candidates; returns `claimToken` plus payments. Default lease is 120 seconds. |
| `recordSubmission(ids, claimToken, txHash, executor)` | Atomically associate a known hash with the claimed batch; stale claims are rejected. |
| `releaseClaims(claimToken, error, retrySeconds?)` | Release unsubmitted claims with backoff; cannot release submitted transactions. |
| `listSubmittedPayments(context)` | Find transactions that require receipt reconciliation. |
| `recordExecution(context, confirmedEvent)` | Record a confirmed PrePaid execution by payer + nonce, including transaction/block hash and executor. |
| `recordSubmissionFailure(id, claimToken, txHash, error, retrySeconds?)` | Retry an item after a confirmed `PaymentFailed` event or reverted receipt. Never use for uncertain RPC responses. |
| `recordScheduleCancellation(key, confirmedEvent)` | Mirror a confirmed cancellation. This function does not call the chain or cancel signatures. |
| `recordAuthorizationUnavailable(context, payer, nonce)` | Mark a used/revoked USDC nonce whose execution is not known; reconcile event history first. |
| `expirePayments(context, chainTimestamp)` | Mark unsubmitted expired windows; submitted transactions remain for receipt checks. |

A server-side save call has this shape:

```typescript
const key = {
  chainId: 5042002,
  prepaid: deployedPrePaidAddress,
  usdc: ARC_USDC,
  payer: connectedWalletAddress,
  scheduleId: randomScheduleId,
};

// signedPayments contain payee, amount, tip, validAfter, validBefore,
// salt and v/r/s. Decimal values are strings, hex values are 0x-prefixed.
await repository.saveSchedule({
  ...key,
  payments: signedPayments,
  label: "Monthly rent",
  metadata: { interval: "monthly", timezone: "Asia/Calcutta" },
});
```

The signing helpers match the current contract's nonce commitment. The
wallet integration must also check USDC's actual `DOMAIN_SEPARATOR()`
and use the **new contract deployment**, not the previous storage-based
contract. Only standard EOA `v/r/s` signatures are supported by this layer.

#### App and relayer integration boundaries

These are trusted repository methods, not public API endpoints.
The app backend authenticates the wallet for account-specific reads and
labels, validates bounded JSON bodies, and verifies signed instructions.
Apply deployment-level request limits to the public APIs before public launch.
Signature verification protects the signed payment instructions; it does
not authenticate an HTTP session or make unsigned labels authoritative.
Never let a browser submit arbitrary “executed” or “cancelled” status updates.

A relayer first reconciles submitted receipts, then claims candidates using
the latest **chain block timestamp**, checks on-chain cancellation and nonce
state, and simulates execution. Release claims when simulation proves an
item cannot be submitted. For a locally signed transaction, persist its
known hash with `recordSubmission` before broadcasting where possible.
The future relayer must retain its prepared transaction for crash recovery.
A timeout or missing receipt does not prove the transaction failed; retain
`submitted` state and reconcile or rebroadcast the same prepared transaction.
An expired unsubmitted lease can be reclaimed using a new claim token.
Leases reduce duplicate submissions but do not guarantee exactly-once
broadcast; USDC nonce consumption prevents duplicate payment on-chain.

Parse every `PaymentExecuted`/`PaymentFailed` event from the expected
contract and confirmed receipt; a successful batch transaction can contain
failed items. Confirmed results may come from another permissionless executor.
Only trusted chain processing calls the status-recording methods.
Cancellation stops pending/leased discovery but leaves submitted items for
reconciliation, since a payment could have executed before cancellation.
Executed history remains intact. Deleting or changing database rows cannot
cancel a still-valid USDC signature.

The database retains current bookkeeping and the latest submitted hash/error,
not a complete history of every attempt. Add an audit migration if that
history becomes necessary. Keep applied migration files unchanged; add new
numbered SQL files for future schema changes. Back up Neon data and isolate
testnet/mainnet deployments; filtering includes both chain and contract.

References: [Postgres.js queries and transactions](https://github.com/porsager/postgres),
[Neon connection pooling](https://neon.com/docs/connect/connection-pooling),
[PostgreSQL SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html).

### Deploy PrePaid to Arc testnet

The deployment uses the existing Hardhat build and one viem script,
`scripts/deploy-testnet.mts`. **Only PrePaid is deployed.** The script points
it to real Arc USDC at `0x3600000000000000000000000000000000000000`;
`MockUSDC` remains exclusively for local tests. No new dependencies are needed.

Run the following from the repository root using Node.js **22.13+**:

1. Install dependencies and run the tests:

   ```powershell
   pnpm install
   pnpm contracts:test
   ```

2. If `.env.testnet` does not already exist, copy the template:

   ```powershell
   Copy-Item .env.testnet.example .env.testnet
   ```

   Open `.env.testnet` in your editor. Replace the private-key placeholder
   with the **0x-prefixed private key of your funded testnet wallet**.
   This wallet becomes PrePaid's initial owner and controls tip withdrawal.
   The default RPC is `https://rpc.testnet.arc.io`; an alternate Arc testnet
   RPC can be used if needed. The file is Git-ignored. Never paste the key
   into chat, a terminal command, or a `NEXT_PUBLIC_` variable.

3. Run the read-only deployment preflight:

   ```powershell
   pnpm contracts:check:testnet
   ```

   Check that the printed deployer address is your funded wallet. The script
   checks chain ID **5042002**, the real USDC interface, native USDC balance,
   and gas estimation using the actual PrePaid constructor. It prints a
   maximum deployment gas cost. It does not sign or submit a transaction.
   Your existing faucet USDC pays for deployment; no token approval or deposit
   into PrePaid is required.

4. Broadcast the deployment:

   ```powershell
   pnpm contracts:deploy:testnet
   ```

   The command rebuilds the contract, repeats the checks, and sends one
   deployment transaction. It uses a 20% gas-limit margin, a fee cap of twice
   the current gas price (at least 20 Gwei), and zero priority fee. Gas fees
   are native USDC in 18-decimal units. After one confirmation, the script
   checks deployed code, `owner()`, and `usdc()` against the expected values.

   The transaction URL and deployed address are printed. Public deployment
   details are saved in `deployments/arc-testnet.json`, including the owner,
   transaction hash, compiler version, constructor arguments, and gas cost.
   Keep this file: it is the deployment record for subsequent integration.

5. Publish the source on [Arc Testnet Explorer's verification page](https://explorer.testnet.arc.io/contract-verification).
   Select Solidity **Standard JSON Input**, use the deployed contract address,
   and upload `deployments/arc-testnet-input.json`. This generated, Git-ignored
   file contains the exact compiler input and imported sources used to build
   PrePaid. Use compiler `v0.8.30+commit.73712a01` (also recorded in the
   deployment JSON). The input already contains optimizer settings (200 runs)
   and the Cancun EVM target. Select `PrePaid` as the contract; its fully
   qualified source name is recorded in the `contract` field.
   If the form asks for constructor arguments, use `constructorArguments`
   from the deployment record; omit its `0x` prefix if the field requires raw hex.

6. Open the address on the explorer. Confirm `owner()` is your deployer wallet
   and `usdc()` is `0x3600000000000000000000000000000000000000`. Once verified,
   the explorer's Contract tab exposes read/write functions. Save the address
   for the wallet-signing UI and the cron relayer. A real signed payment,
   cancellation, and tip withdrawal are the next integration checks before
   mainnet deployment.

If a command reports a network error, retry the **check** command or set another
testnet RPC in `.env.testnet`. A mainnet RPC is rejected before broadcasting.
If deployment printed a transaction hash but receipt waiting or read-back failed,
inspect that hash on the explorer and consult `deployments/arc-testnet.json`.
**Do not blindly run deploy again:** a transaction may already have succeeded.
The script refuses to deploy when that record exists. Move it aside only after
checking the transaction and intentionally deciding to deploy a new contract.
Each intentional deployment creates a new address; old signatures do not move
to the new contract.

This workflow follows [Arc's deployment and verification guide](https://docs.arc.io/arc/tutorials/deploy-on-arc)
and [Arc gas requirements](https://docs.arc.io/arc/references/gas-and-fees).
The deployment script is tested end to end against a local EVM; the preflight
command is the live check against your chosen Arc testnet RPC.

### PrePaid smart contract

The contract lives at `packages/contracts/contracts/PrePaid.sol`. It uses
Hardhat 3, OpenZeppelin 5.4.0 and Solidity 0.8.30 (Cancun target).
Run from the repository root with Node.js **22.13+**:

```powershell
pnpm contracts:build
pnpm contracts:test
pnpm contracts:typecheck
```

The constructor takes the real USDC address. Arc documents
`0x3600000000000000000000000000000000000000` on both networks.
The deployer is the initial owner; ownership transfers require acceptance
through OpenZeppelin's two-step flow. Token checks use `decimals()` and
`DOMAIN_SEPARATOR()` without requiring ordinary token bytecode.

#### Storage responsibilities

| Location | Information |
| --- | --- |
| PrePaid storage | `cancelledSchedules[payer][scheduleId]`, the platform's `accruedTips`, ownership and the immutable USDC address. |
| USDC storage | Used or revoked authorization nonces, through `authorizationState(payer, nonce)`. |
| PostgreSQL database | Signatures, full payment instructions, derived nonces, recurrence metadata, labels, discovery indexes, transaction hashes and retry bookkeeping. |
| Transaction receipts | Successful payments, failed batch items, cancellations and withdrawals. |

There is no on-chain schedule registration, payment array, signature storage,
payment counter, or duplicate execution flag. The database schema and shared
queries and wallet signing UI are implemented; cron integration remains a next step.
Submitted payment details and signatures are public transaction calldata;
moving them out of contract storage does not make executed signatures private.

#### Contract functions

| Function | Purpose |
| --- | --- |
| `getPaymentNonce(payment)` | Read the instruction commitment to use as the USDC authorization nonce before signing. |
| `executePayment(payment)` | Anyone submits one signed payment; any failure reverts the transaction. |
| `executePayments(payments)` | Anyone submits 1–50 complete payment payloads. Returns the successful count and isolates item failures. |
| `cancelSchedule(scheduleId)` | Permanently cancels this schedule for `msg.sender`. Works before the first payment executes. |
| `cancelledSchedules(payer, scheduleId)` | Read the authoritative cancellation flag. |
| `withdrawTips(recipient)` | Current owner withdraws the platform's earned share. |
| `accruedTips()` | Read platform earnings available to withdraw, in six-decimal USDC units. |

`executePaymentFromBatch` is a self-call worker for failure isolation and
rejects external callers. Old functions such as `createSchedule`,
`getPayment` and `getDuePaymentIds` have been removed. Existing deployed
instances retain their old implementation: this change requires a **new
deployment and freshly signed authorizations**. The current deployment record
is preserved; deployment is a separate next step.

#### Preparing and signing a payment

The flat `Payment` payload has these fields:

```text
payer       address   wallet signing the USDC authorization
scheduleId  bytes32   random nonzero ID shared by this payer's recurring occurrences
payee       address   final payment recipient
amount      uint256   payee amount, six-decimal USDC units
tip         uint256   total executor + platform tip, six-decimal USDC units
validAfter  uint256   exclusive lower bound, UNIX seconds
validBefore uint256   exclusive upper bound, UNIX seconds
salt        bytes32   fresh cryptographically random value for every occurrence
v           uint8     signature v (27 or 28)
r           bytes32   signature r
s           bytes32   signature s
```

Generate the schedule ID and each salt with a cryptographic random generator;
never reuse a cancelled schedule ID for that payer. Different occurrences
need different salts even if all their other fields are identical.

USDC's ordinary signature does not name the final payee or the tip split.
PrePaid binds those instructions using the signed nonce:

```text
PAYMENT_NONCE_TYPEHASH = keccak256(
  "PrePaidPayment(uint256 chainId,address prepaid,address usdc,address payer,bytes32 scheduleId,address payee,uint256 amount,uint256 tip,uint256 validAfter,uint256 validBefore,bytes32 salt)"
)

nonce = keccak256(abi.encode(
  PAYMENT_NONCE_TYPEHASH, chainId, prepaidAddress, usdcAddress,
  payer, scheduleId, payee, amount, tip, validAfter, validBefore, salt
))
```

Use ordinary ABI encoding, **not packed encoding**. Alternatively, call
`getPaymentNonce(payment)` with placeholder `v=0, r=0x00…00, s=0x00…00`;
signature fields do not affect the result. The tests independently reproduce
this encoding using viem.

Sign the standard USDC `ReceiveWithAuthorization` EIP-712 message:

```text
from:        payer
to:          deployed PrePaid address
value:       amount + tip
validAfter:  payment.validAfter
validBefore: payment.validBefore
nonce:       the commitment above (not an unrelated random nonce)
```

Use USDC's domain: `name="USDC"`, `version="2"`,
`verifyingContract=USDC address`, with the correct chain ID
(`5042002` for testnet, `5042` for mainnet).
Verify this against USDC's on-chain `DOMAIN_SEPARATOR()` during wallet
integration. Split the resulting 65-byte signature into `v/r/s`, then store
the complete payload and derived nonce off-chain. No setup transaction,
approval, deposit, or additional application signature is required.
The token itself verifies the authorization during execution; a
`TransferWithAuthorization` signature will not work here. This interface
uses the standard `v/r/s` overload; it does not promise contract-wallet or
arbitrary-length signature support.

A compromised database/relayer can withhold payments but cannot change signed
routing, amounts, tips, schedule IDs, windows or salts and still execute them.
USDC signatures made for the previous contract/nonce format are incompatible.

#### Execution, cancellation and earnings

The future relayer queries candidate database rows using the latest chain
timestamp, checks cancellations and USDC nonce state, then submits complete
payloads in batches of at most 50. These preliminary checks reduce wasted
gas; the contract and USDC remain authoritative. There is no automatic
scheduler on-chain. Payments must satisfy
`validAfter < block.timestamp < validBefore`.

For each success, PrePaid receives exactly `amount + tip`, transfers
`amount` to the committed payee, transfers `floor(tip * 70 / 100)` to the
executor (`msg.sender` of the single/batch entry point), and retains the
remainder in `accruedTips`. Rounding dust goes to the platform.
For 100 USDC plus a 1 USDC tip: the payee receives 100, the executor receives
0.70, and the platform retains 0.30 USDC. Zero tips are supported.

Receipt, forwarding and executor compensation are atomic. A failed payee
**or executor** transfer rolls back the payer debit, nonce consumption and
platform ledger. Each failed batch item emits `PaymentFailed` with its
zero-based input index and revert bytes; healthy items still execute.
A successful transaction receipt alone does not mean every item succeeded:
reconcile `PaymentExecuted` and `PaymentFailed` events before updating DB
statuses. USDC's `authorizationState=true` can mean execution or revocation;
use receipt events to distinguish them. Two relayers submitting the same
authorization cannot double-pay or earn two tips.

Execution is permissionless: another executor can submit first and earn the
70% tip. Failed items pay no tip, and tips do not guarantee reimbursement of
gas costs. Calling through another contract pays that calling contract;
direct EOA relayers receive the tip in their own wallet.

Each batch worker has a 300,000-gas allowance. Too little outer gas reverts
the entire batch with `InsufficientBatchGas`; use gas estimation and a margin.
Single-payment execution has no worker gas cap. Arc gas uses native USDC
with **18 decimals**; payment/tip amounts use the ERC-20 interface's **6
decimals**. Arc requires a fee cap of at least 20 Gwei.

Cancellation is a payer transaction and requires gas. Once included, its
permanent flag blocks all remaining signed occurrences in that schedule,
even if somebody retains their signatures or changes the database.
Cancelling the same ID from another wallet affects only that wallet's
namespace. Changing the original payload to use another schedule invalidates
its signature. Cancellation cannot reverse an already executed payment or
guarantee priority over a payment included first.

Owner withdrawals transfer only accrued platform earnings. Direct donations
are excluded; a failed withdrawal restores the ledger. The owner cannot
change signed instructions or the fixed tip split, and there is no upgrade
mechanism.

Tests cover nonce encoding and tampering, real EIP-712 signatures, boundaries,
replay/revocation, cancellation, 50-item batches, failure rollback, both tip
transfers, rounding, ownership, withdrawals and reentrancy. The test-only
`MockUSDC` runs on Hardhat's standard EVM and is never deployed by the Arc
deployment script. Real Arc payment/cancellation checks remain necessary
after deployment because local EVMs do not reproduce Arc's native runtime.

References: [Arc EIP-3009 relayer](https://docs.arc.io/integrate/relayers-and-paymasters/eip-3009-relayer),
[Arc USDC addresses](https://docs.arc.io/arc/references/contract-addresses),
[Arc EVM differences](https://docs.arc.io/arc/references/evm-differences),
[EIP-3009](https://eips.ethereum.org/EIPS/eip-3009).

### Check Arc USDC `receiveWithAuthorization`

From the project root (Node.js 20.9+):

```bash
pnpm install
pnpm check:receive:testnet
pnpm check:receive:mainnet
```

Both commands run `scripts/check-receive-with-authorization.ts` using viem.
They query the documented USDC interface at
`0x3600000000000000000000000000000000000000`. Testnet expects chain ID
`5042002`; mainnet expects `5042`. No edits are needed to switch networks.
These are read-only `eth_call` simulations: no wallet, private key, USDC, or
transaction submission is needed.

The script checks this standard EIP-3009 signature:

```text
receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)
```

It calls the function with deliberately expired arguments and an invalid
signature, first with a caller different from the payee, then with the payee
as caller. Circle's standard implementation returns the specific errors
`FiatTokenV2: caller must be the payee` and
`FiatTokenV2: authorization is expired`, respectively. Unknown-selector
control calls must not return those same checks. A transfer probe is printed
for comparison. All calls use one reported block so the result is reproducible.

Interpret the final line:

- **CONFIRMED** (exit code 0): the required selector reached the payee and
  expiry checks, distinct from the unknown-selector controls.
- **INCONCLUSIVE** (exit code 2): the checks were not confirmed. Empty return
  data, generic reverts, different error implementations, paused/blocklisted
  behavior, or missing functions can produce this result. It does not prove
  absence. A `bytes` signature overload is not checked.
- **CHECK FAILED** (exit code 1): configuration or RPC connectivity failed.
  This says nothing about function presence. Public endpoints can also return
  a block-not-yet-available error; rerun or try another RPC.

To use another RPC in PowerShell, set its URL before running either command:

```powershell
$env:ARC_RPC_URL = "https://your-arc-testnet-rpc"
pnpm check:receive:testnet
Remove-Item Env:ARC_RPC_URL
```

For mainnet, use a mainnet URL and `pnpm check:receive:mainnet`. Environment
variables are read from the current shell; the script does not load `.env` files.

Confirmation establishes function presence at the reported block, not a
successful payment. A valid signed payment through PrePaid still needs an
integration test. With `receiveWithAuthorization`, the signed `to` address
must be the contract calling USDC (`msg.sender`), so PrePaid must receive the
payment and forward it to the final payee within its transaction. The payer
must sign the `ReceiveWithAuthorization` typed data, not `TransferWithAuthorization`.

References: [Arc contract addresses](https://docs.arc.io/arc/references/contract-addresses),
[Arc RPC endpoints](https://docs.arc.io/arc/references/rpc-endpoints),
[Circle EIP-3009 implementation](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP3009.sol).

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
