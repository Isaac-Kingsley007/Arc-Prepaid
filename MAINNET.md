# Mainnet rollout

The app and relayer default to mainnet. Set `NEXT_PUBLIC_ARC_NETWORK=testnet`
to keep a testnet deployment. The selector is public and embedded in the web
build: rebuild/redeploy after changing it. Set the same selector for the CLI
and GitHub Actions. An RPC override must belong to that network.

Official settings: chain ID **5042**, RPC `https://rpc.mainnet.arc.io`, explorer
`https://explorer.arc.io`, USDC interface
`0x3600000000000000000000000000000000000000`. Native gas uses 18 decimals;
USDC authorization amounts use 6. Sources:
[network details](https://docs.arc.io/arc/references/connect-to-arc),
[contract addresses](https://docs.arc.io/arc/references/contract-addresses).

## 1. Pause automated execution during the change

Set the GitHub Actions repository variable `CRON_RELAYER_ENABLED=false`.
Resolve any submitted testnet relayer transactions before changing its network
or database. Keep the testnet database and deployment record for recovery.
Changing network does not cancel existing authorizations: cancel remaining
testnet schedules on testnet if desired.

## 2. Deploy PrePaid

Copy `.env.mainnet.example` to `.env.mainnet`. Add a funded mainnet deployer's
**0x-prefixed** private key to `ARC_MAINNET_PRIVATE_KEY`. The deployer becomes
the initial owner and can withdraw the platform's collected tips. Testnet
faucet USDC cannot pay mainnet gas. Never commit this file or put this key in
Vercel.

Run from the repository root:

```powershell
pnpm contracts:check:mainnet
pnpm contracts:deploy:mainnet
```

The first command estimates the deployment and checks the network, token and
funding without signing or sending. The second spends real USDC and deploys
only PrePaid. It saves `deployments/arc-mainnet.json` and exact compiler input
in `deployments/arc-mainnet-input.json`. If receipt waiting fails, inspect the
saved transaction hash before retrying. An existing deployment record prevents
accidental redeployment.

Verify the source on the mainnet explorer using the generated standard JSON
input, compiler version, constructor arguments and contract name from the
record. Commit the public deployment record; compiler input is Git-ignored.
Mainnet requires an explicit `PREPAID_CONTRACT_ADDRESS`, even with a record.

If this Windows machine needs system CA trust, use the equivalent commands:

```powershell
pnpm contracts:build
node --use-system-ca --env-file=.env.mainnet --import tsx scripts/deploy-mainnet.mts --check
node --use-system-ca --env-file=.env.mainnet --import tsx scripts/deploy-mainnet.mts --deploy
```

## 3. Database and web app

No database wipe or schema change is needed. Existing rows are scoped by chain
ID and PrePaid address. Prefer a separate Neon database or branch for mainnet;
retain testnet data rather than deleting it. A cloned Neon branch may contain
testnet rows, which remain isolated by those scopes.

Set `.env.local` to the mainnet database and settings below, then run:

```powershell
pnpm db:migrate
pnpm db:check
```

Apply the same variables to the intended Vercel environment:

| Variable | Mainnet value |
| --- | --- |
| `NEXT_PUBLIC_ARC_NETWORK` | `mainnet` |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Your Reown project ID |
| `PREPAID_CONTRACT_ADDRESS` | Address from `arc-mainnet.json` |
| `ARC_RPC_URL` | `https://rpc.mainnet.arc.io` or a mainnet provider |
| `DATABASE_URL` | Mainnet Neon pooled connection URL |
| `DATABASE_POOL_MAX` | `3` |
| `APP_ORIGIN` | Exact HTTPS origin users visit, without a path |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` |

Deploy the repository root with the Next.js preset and `pnpm build`. Keep the
default output directory. Add the deployed origin to Reown's allowed origins.
Rebuild after setting the variables. Configure Preview separately if it should
remain on testnet, including its own origin, database, RPC and contract.
Never upload deployer or relayer private keys to the web host.

## 4. Cron relayer

Update `.env.relayer` and GitHub Actions to use the same mainnet database,
contract and network as the app. Fund the dedicated relayer with mainnet USDC.

GitHub Actions secrets:
- `DATABASE_URL`: mainnet pooled Neon URL.
- `RELAYER_PRIVATE_KEY`: funded relayer's 0x-prefixed private key.
- `ARC_RPC_URL`: optional mainnet RPC, if using a secret provider URL.

Repository variables:
- `NEXT_PUBLIC_ARC_NETWORK=mainnet`.
- `PREPAID_CONTRACT_ADDRESS`: new mainnet address.
- `RELAYER_ADDRESS`: dedicated relayer's public address.
- `ARC_RPC_URL`: optional public mainnet RPC. A secret RPC takes precedence;
  remove or update any old testnet secret.
- Keep `CRON_RELAYER_ENABLED=false` until the dry run passes.

Existing batch/gas/tip-loss limits still apply. Review them for real USDC.
The default permits an estimated loss of up to 0.02 USDC per batch, with up to
3 batches per run. Failed transactions and fee changes can affect actual cost.

Local dry run:

```powershell
node --use-system-ca --conditions=react-server --env-file=.env.relayer --import tsx scripts/relayer.ts --dry-run
```

Push the workflow to the default branch. In **Actions → Arc cron relayer**,
run manually with `dry_run` checked. Confirm the log says **Arc Mainnet**,
the correct address and chain. Then enable `CRON_RELAYER_ENABLED=true`, run
one small live batch manually with `dry_run` unchecked, and confirm a later
scheduled run. The hourly schedule is minute 17 UTC, or minute 47 in India.

## 5. Verify with small real payments

- Connect and sign in on mainnet. Create fresh signatures; testnet signatures
  cannot be reused on mainnet or for a new contract.
- Create a small payment whose window opens soon, then reload the dashboard.
- Execute it from the user relayer. Check the payee receives the amount,
  the relayer receives 70% of the tip (rounded down), and the remaining tip
  accrues in PrePaid. Gas is separate.
- Cancel another schedule and confirm it cannot execute.
- Execute a small payment with the cron relayer and confirm database status.
- Confirm the owner and verify withdrawal of collected platform tips.

This rollout prepares the code; it does not deploy, migrate your live database,
change cloud settings, broadcast payments or prove a full mainnet payment flow.
