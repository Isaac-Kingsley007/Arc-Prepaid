This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

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
