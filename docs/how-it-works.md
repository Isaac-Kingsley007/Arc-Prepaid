# How PrePaid works

[All user docs](README.md)

## What you authorize

You sign one EIP-3009 `ReceiveWithAuthorization` message per payment. Each authorization permits a specific amount plus tip to reach the PrePaid contract during a specific window.

Its signed nonce also commits to the final recipient, amount, tip, payer, schedule, time window, network, contract and a fresh random salt. A relayer cannot change those instructions and retain a valid signature. A mainnet signature cannot be reused on testnet or with a different PrePaid deployment.

There is no standing token approval or upfront deposit. Signing authorizes future execution; it does not reserve money or guarantee that a payment will happen.

## Settlement and fees

When a relayer submits a valid payment, PrePaid receives `amount + tip` from USDC and routes the recipient's amount and relayer's tip share in the same transaction. The platform's share remains in the contract for withdrawal by its owner.

| For a 10 USDC payment with a 1 USDC tip | Amount |
| --- | --- |
| Recipient receives | 10 USDC |
| Relayer receives | 0.70 USDC |
| Platform retains | 0.30 USDC |
| Payer's authorized transfer | 11 USDC |

The relayer separately pays gas in USDC. The relayer share is rounded down; any rounding remainder stays with the platform. Zero tips are supported.

Signing in and signing payment authorizations are free. Cancellation costs the payer transaction gas. Executing payments costs the relayer transaction gas. Failed transactions do not refund gas.

If an individual payment's transfers fail, its payer debit, authorization consumption and tip accounting roll back together. A batch can include both successful and failed payments; check its individual results rather than just the transaction's overall status.

## Cancellation and replay protection

The payer cancels a schedule with one transaction. Once confirmed, PrePaid blocks its remaining occurrences even if someone retains copies of their signatures. Cancellation cannot undo payments that executed first.

The USDC authorization names PrePaid as its recipient. `receiveWithAuthorization` requires the recipient to make the call, so an executor cannot bypass the contract's cancellation check by calling USDC directly. USDC also tracks consumed authorization nonces to prevent repeat payments.

## What is stored and visible

| Location | Purpose |
| --- | --- |
| PostgreSQL | Stores signed instructions, schedule details and status bookkeeping so the app and relayers can find payments. |
| PrePaid contract | Enforces schedule cancellation and accounts for platform tips. |
| USDC and transaction receipts | Enforce authorization validity and record on-chain transfers and execution events. |

Wallet sign-in protects access to your saved schedules. The relayer page shows due-payment routing and reward information without showing private schedule labels. Executed transaction data is public on the blockchain.

The database cannot alter signed routing or amounts, but unavailable or withheld signatures can prevent relayers from executing a payment. The database is not an on-chain cancellation mechanism.

## Current scope

PrePaid supports standard EOA wallets, daily/weekly/monthly intervals and up to 50 payments per schedule. Each occurrence expires 24 hours after its scheduled time, capped at the next occurrence. The displayed expiry is exclusive: execution must happen before it.

Funds stay spendable in your wallet until execution. You must have enough USDC for the amount plus tip, and a relayer must submit within the window. Expired occurrences are not automatically rescheduled. To change a signed recipient, amount, tip or date, cancel the remaining schedule and create a new one.

Arc uses USDC for both transfers and gas. Mainnet uses real USDC; testnet signatures and faucet funds do not move to mainnet. See [Arc's network guide](https://docs.arc.io/arc/references/connect-to-arc) for wallet settings.
