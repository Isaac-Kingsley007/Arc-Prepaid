# PrePaid

**Recurring USDC payments on Arc, without upfront deposits or standing token approvals.**

PrePaid lets you plan payments in advance while keeping your USDC in your wallet until each payment executes. Think of post-dated cheques: every signed payment has a fixed recipient, amount and time window.

**[Open the live app](https://arc-prepaid.vercel.app/)** ? **[Mainnet contract](https://explorer.arc.io/address/0xacc4afcb52aa8a27a9be3a0a8da58580243889eb)** ? **[Become a relayer](https://arc-prepaid.vercel.app/relayer)**

Built for [Arc Microgrants](https://dorahacks.io/hackathon/arc-microgrants/detail).

## The problem

Stablecoin payments on-chain are **push-only**: money moves only when the payer sends it.
Rent, allowances, subscriptions and regular payouts repeat. Sending each payment manually means remembering every due date. Other approaches require a standing spending allowance or money deposited into a contract ahead of time.

PrePaid offers a way to authorize specific future payments without granting open-ended spending permission or locking up the whole schedule's funds.

## Our Solution

**PrePaid lets you sign a whole payment schedule once, with no standing approval and no deposit. Your USDC stays in your wallet until each payment actually executes.**

Think of post-dated cheques. Each payment is made out to one payee, for one amount, valid only inside its own time window.

## How it works

1. **Plan.** Choose the recipient, amount, optional tip, start time and interval. Schedule daily, weekly or monthly payments, ending after a chosen count or date.
2. **Sign and save.** Your wallet signs one USDC `ReceiveWithAuthorization` message per payment. The app verifies and stores the signed instructions in PostgreSQL. Signing sends no transaction and moves no funds.
3. **Execute when due.** A relayer submits eligible payments to PrePaid and pays gas. The contract checks cancellation and the payment window, then calls USDC's `receiveWithAuthorization`.
4. **Settle.** In the same transaction, USDC enters PrePaid, the recipient receives the payment, and the tip is split: **70% to the relayer, 30% to the platform**. A failed payment rolls back its transfers; other healthy items in a batch can still execute.
5. **Cancel when needed.** One payer transaction permanently cancels every remaining payment in a schedule. Completed payments stay completed.

For a **10 USDC payment with a 1 USDC tip**, the recipient receives 10, the relayer receives 0.70, and the platform retains 0.30. Relayer gas is separate.

### What makes the authorization safe?

Each signed nonce commits to the payer, recipient, amount, tip, schedule, time window, chain, contract and a fresh random salt. Changing those instructions invalidates the signature. USDC prevents reuse of consumed authorizations.

The authorization's recipient is PrePaid itself. Because `receiveWithAuthorization` requires that recipient to call USDC, an executor cannot bypass PrePaid's cancellation check by submitting the signature directly to USDC.

PostgreSQL stores signatures and searchable payment details. The contract stores cancellation flags and accrued platform tips; USDC tracks used authorizations. The database helps relayers find payments, but cannot change their signed instructions or decide whether they are valid on-chain.

## Why Arc?

Arc uses **USDC for both payments and gas**, so users and relayers do not need a separate gas token. Its USDC interface supports the EIP-3009 authorization flow that PrePaid uses to settle signed payments.

PrePaid uses Arc for payment execution, schedule cancellation, relayer compensation and platform-tip settlement. See [Arc's network details](https://docs.arc.io/arc/references/connect-to-arc) and [EIP-3009 relayer documentation](https://docs.arc.io/integrate/relayers-and-paymasters/eip-3009-relayer).

## Mainnet deployment and proof

| Item | Evidence |
| --- | --- |
| Network | Arc Mainnet ? chain ID `5042` |
| PrePaid contract | [`0xacc4afcb52aa8a27a9be3a0a8da58580243889eb`](https://explorer.arc.io/address/0xacc4afcb52aa8a27a9be3a0a8da58580243889eb) |
| Deployment | [Successful deployment transaction](https://explorer.arc.io/tx/0x351425f67d8ce2c2af78d7d718669b6a08a0e91b47f6bdc47841f4f475fc4ccc) |
| Payment execution | [Successful payment transaction 1](https://explorer.arc.io/tx/0x4a877450405c478100da2be64b66564b706691b6f7694733510c048c0e4b0d0e) |
| Payment execution | [Successful payment transaction 2](https://explorer.arc.io/tx/0x2b6080005b3a07a8c0ddbeb6818af75c920d8829e196a9b205439c0190bf9161) |

Both payment transactions have successful receipts and emit `PaymentExecuted` from this contract. The public [deployment record](deployments/arc-mainnet.json) includes its address, deployment hash, compiler version and constructor arguments. Contract source: [PrePaid.sol](packages/contracts/contracts/PrePaid.sol).

## Try it

Read the [User documentation](docs/README.md) for payment, cancellation and relayer guides.

1. Open the [app](https://arc-prepaid.vercel.app/) and connect an EOA wallet on Arc Mainnet.
2. Enter a payment schedule, review the dates and totals, then choose **Sign & save**. Confirm the sign-in message if requested, followed by each payment authorization.
3. Open **My payments** to view saved schedules or **Cancel remaining payments** to stop a schedule.
4. To execute due payments, open [Become a relayer](https://arc-prepaid.vercel.app/relayer), sign in, prepare a batch, review the expected tips and gas estimate, then confirm execution.

Wallet sign-in proves ownership so the app can show your saved payments. It is free and does not authorize a payment. Cancellation and execution are on-chain transactions and cost USDC gas.

## Relayers and payment windows

- **User relayer:** anyone with a supported wallet can prepare and execute due payments from the relayer page.
- **Cron relayer:** a plain TypeScript script runs through GitHub Actions on an hourly schedule, with manual execution and read-only dry runs.

Payments remain executable for **24 hours after their scheduled time, capped at the next payment**. Funds are not reserved: the payer needs enough USDC when execution happens. Expired payments are not automatically carried forward.

Execution depends on available signatures, sufficient funds and a relayer submitting within the window. GitHub schedules may be delayed. Tips are optional and do not guarantee a profit after gas. The app supports up to **50 payments per schedule** and standard EOA signatures; contract wallets are outside the current scope.

## Run locally

Use **Node.js 22.13+** and **pnpm**.

Copy [.env.local.example](.env.local.example) to `.env.local`. Set your Neon pooled `DATABASE_URL`, Reown project ID, the mainnet contract address above, and `APP_ORIGIN=http://localhost:3000`. The template supplies the mainnet network and RPC settings.

```sh
pnpm install
pnpm db:migrate
pnpm db:check
pnpm dev
```

Open `http://localhost:3000`. For a separate testnet setup, set `NEXT_PUBLIC_ARC_NETWORK=testnet` and use the matching RPC, contract and database. Rebuild after changing the network selector.

Deployment, Vercel variables, cron configuration and Windows certificate guidance are in [MAINNET.md](MAINNET.md). Keep database credentials and private keys out of Git and browser environment variables.

## Stack and verification

| Layer | Technology |
| --- | --- |
| Web app | Next.js, TypeScript, Tailwind CSS |
| Wallet and chain access | RainbowKit, wagmi, viem |
| Contract | Solidity 0.8.30, OpenZeppelin, Hardhat |
| Database | Neon PostgreSQL, Postgres.js |
| Automation | Node.js/TypeScript, GitHub Actions |

```sh
pnpm contracts:test
pnpm db:test
pnpm exec tsx --test app/schedule.test.ts
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

Tests cover signed instructions, tampering, replay protection, cancellation, batch failure isolation, tip splitting, wallet authentication, database claims and relayer recovery.

For deeper implementation details and earlier development notes, see [FULL_CONTEXT.md](FULL_CONTEXT.md). [MAINNET.md](MAINNET.md) is the current deployment guide.
