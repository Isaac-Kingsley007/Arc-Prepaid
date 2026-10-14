# PrePaid user docs

PrePaid lets you schedule recurring USDC payments on Arc without upfront deposits or standing token approvals. Your money stays in your wallet until a signed payment executes.

[Open PrePaid](https://arc-prepaid.vercel.app/) | [Open the relayer page](https://arc-prepaid.vercel.app/relayer)

## Choose a guide

- [Payments and cancellation](payments.md): connect your wallet, create a schedule, view its status and cancel remaining payments.
- [Become a relayer](relayers.md): execute due payments, review gas and tips, and recover submitted transactions.
- [How PrePaid works](how-it-works.md): understand authorizations, fees, payment windows and what your signatures permit.

## Before you start

The live app uses **Arc Mainnet**, chain ID **5042**. Use a standard EOA wallet; contract-wallet signatures are not supported by the current app. You need mainnet USDC when a payment executes and when you submit a transaction such as cancellation. Testnet faucet USDC cannot be used on mainnet.

Connecting a wallet and signing in are separate steps. Signing in proves wallet ownership so the app can show your saved schedules. It does not authorize a payment or move money.

PrePaid's mainnet contract is [0xacc4afcb52aa8a27a9be3a0a8da58580243889eb](https://explorer.arc.io/address/0xacc4afcb52aa8a27a9be3a0a8da58580243889eb). See the [project README](../README.md#mainnet-deployment-and-proof) for successful deployment and payment transactions.

These guides describe the current user experience. Developer deployment instructions are in [MAINNET.md](../MAINNET.md); [FULL_CONTEXT.md](../FULL_CONTEXT.md) preserves earlier implementation notes and may describe previous project stages.
