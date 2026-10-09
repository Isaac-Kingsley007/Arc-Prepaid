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

This is a UI preview. The wallet button explains the upcoming integration;
it does not connect a wallet. Reviewed plans can be saved as unsigned drafts
for the current page session, reused, or discarded. Refreshing clears drafts.
There are no signatures, RPC calls, or on-chain payments/cancellations yet.
Authorization execution windows will be configured during wallet integration.

Check the UI with `pnpm lint`, `pnpm exec tsc --noEmit`, and
`pnpm exec tsx --test app/schedule.test.ts`.

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

The Solidity contract lives at `packages/contracts/contracts/PrePaid.sol`.
It has its own Hardhat 3 + TypeScript package, uses OpenZeppelin 5.4.0, and
compiles with the pinned Solidity 0.8.30 npm compiler targeting Cancun
(compatible with Arc's documented Osaka baseline). Use Node.js **22.13+**.

Run these commands from the repository root:

```bash
pnpm install
pnpm contracts:build
pnpm contracts:test
pnpm contracts:typecheck
```

The constructor takes a USDC address. For both Arc testnet and mainnet, use
`0x3600000000000000000000000000000000000000`. The deployer becomes the owner
and can transfer ownership through OpenZeppelin's two-step flow. Constructor
checks query `decimals()` and `DOMAIN_SEPARATOR()`; they do not depend on
the token address having ordinary contract bytecode.

| Function | Caller and purpose |
| --- | --- |
| `createSchedule(PaymentInput[] inputs)` | Payer submits one setup transaction to store all payment details and signatures. Returns a schedule ID. |
| `executePayment(paymentId)` | Anyone executes one payment whose window is open. Reverts if it cannot complete. |
| `executePayments(paymentIds)` | Cron relayer or anyone submits up to 50 IDs. Checks their windows, skips non-ready payments, and isolates failed payments. |
| `cancelSchedule(scheduleId)` | The schedule's payer cancels every remaining payment with one flag update. |
| `withdrawTips(recipient)` | Current owner withdraws all accrued tips as ERC-20 USDC. |
| `getPayment(paymentId)` / `schedules(scheduleId)` | Read stored signatures, forwarding instructions, and schedule ownership. |
| `getPaymentState(paymentId)` | Read `Unknown=0`, `Pending=1`, `Ready=2`, `Executed=3`, `Cancelled=4`, or `Expired=5`. |
| `getDuePaymentIds(cursor, scanLimit)` | Read up to 100 stored records and return ready IDs plus the next cursor. |
| `getPayerScheduleIds(payer, offset, limit)` | Read a page of a payer's schedules; `payerScheduleCount(payer)` gives the total. |

Each `PaymentInput` stores `payee`, `amount`, `tip`, `validAfter`,
`validBefore`, `nonce`, `v`, `r`, and `s`. All amounts use **six decimals**:
100 USDC is `100_000_000`; a 1 USDC tip is `1_000_000`.
The signed USDC `value` must equal `amount + tip` (101 USDC in this example).
Different payments in one schedule may have different payees, amounts, tips,
and time windows. Schedules are immutable after creation and contain at most
50 payments; their payment IDs are consecutive, starting at `firstPaymentId`.

#### Signing and registering

For each payment, the payer signs the standard USDC `ReceiveWithAuthorization`
EIP-712 message with:

```text
from:        payer's wallet address
to:          deployed PrePaid contract address
value:       amount + tip
validAfter:  exclusive lower bound, UNIX seconds
validBefore: exclusive upper bound, UNIX seconds
nonce:       unique random bytes32, never reused by that payer
```

Use the **USDC** EIP-712 domain, not PrePaid's address as the verifying contract:
`name="USDC"`, `version="2"`, `verifyingContract=USDC address`, and
`chainId=5042002` (testnet) or `5042` (mainnet). Check this domain against
USDC's onchain `DOMAIN_SEPARATOR()` when integrating the wallet. The contract
validates each signature using the actual onchain domain separator.
Split the wallet's 65-byte signature into `v` (27 or 28), `r`, and `s`.
`TransferWithAuthorization` signatures are rejected.

The payer then calls `createSchedule(inputs)` from **the same wallet that
signed**. This setup transaction is necessary because USDC's signature
authorizes receiving funds at PrePaid; it does not itself specify the final
payee or how the total splits between payment and tip. The payer's transaction
authenticates those instructions. A third party cannot register stolen
USDC signatures under a different payee. No approval or deposit is required,
but setup and cancellation transactions require the payer to have USDC for gas.
Compatible ERC-1271 payers can be validated with a 65-byte signature;
arbitrary-length contract-wallet signatures are outside this interface.

#### Execution and the cron job

On each cron run, start discovery at cursor `1` and call
`getDuePaymentIds(cursor, 100)` until the returned cursor reaches
`nextPaymentId()`. Restart discovery on each run: a record skipped today may
become due later. Split the returned IDs into batches of at most 50 and call
`executePayments(ids)`. Events can also be used to track schedules offchain
without a database. The contract rechecks state/time during execution, so
IDs discovered before a cancellation cannot bypass it.

Payment windows are strictly `validAfter < block.timestamp < validBefore`,
matching USDC's EIP-3009 behavior. `Ready` checks the local schedule and time;
it does not guarantee sufficient payer balance or that USDC is unpaused,
unblocked, or the nonce remains unrevoked.

For each successful payment, PrePaid receives exactly `amount + tip`,
forwards `amount` to the stored payee, retains `tip`, and marks the payment
executed. The whole payment is atomic. If receiving or forwarding fails,
the payer debit, USDC nonce consumption, local execution flag, and tip
accounting all revert. A failed batch item emits `PaymentFailed` and can be
retried within its window; healthy items in the batch still execute.
`PaymentSkipped` reports non-ready IDs. Duplicate IDs cannot double-pay.
`PaymentExecuted` records the executor; **tips belong to the contract's owner,
not the executor**, following the requested treasury/cron model.

Use gas estimation and an appropriate margin for execution. Each batch item
has a 300,000-gas subcall allowance. Insufficient outer gas reverts with
`InsufficientBatchGas`, rather than silently skipping due work. If a future
USDC implementation needs more than the batch allowance, use the single
`executePayment` function, which does not impose that subcall cap.
On Arc, transaction gas is paid by the caller in native USDC (18 decimals).
Set `maxFeePerGas` to at least `20_000_000_000` (20 Gwei), as Arc requires.

#### Cancellation and tip withdrawal

`cancelSchedule` is effective once included onchain. It prevents all future
executions from that schedule, does not reverse completed payments, and does
not affect other schedules. Cancellation does not loop over signatures or
call USDC's `cancelAuthorization`: the signed receiver is PrePaid, and its
execution path enforces the schedule's flag. Reserved nonces remain reserved
forever, so cancelled signatures cannot be registered again. A payer may
also independently revoke a nonce at USDC; subsequent execution then fails.

`withdrawTips(recipient)` transfers the entire `accruedTips` ledger and resets
it to zero. A failed transfer restores that ledger. Direct donations are not
treated as earned tips and are not withdrawn by this function. Payment
instructions cannot be altered by the owner, and there is no upgrade mechanism.

Tests cover real EIP-712 signatures, timing boundaries, replay, cancellation,
batch failure isolation, forwarding rollback, tip withdrawals, and reentrancy.
They run against a test-only USDC mock on Hardhat's standard EVM. Arc's native
USDC runtime is different: a real testnet payment and cancellation should be
verified before mainnet use. This change does not deploy a contract.

References: [Arc EIP-3009 relayer](https://docs.arc.io/integrate/relayers-and-paymasters/eip-3009-relayer),
[Arc EVM differences](https://docs.arc.io/arc/references/evm-differences),
[EIP-3009](https://eips.ethereum.org/EIPS/eip-3009),
[Hardhat TypeScript testing](https://hardhat.org/docs/guides/testing/using-viem).

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
