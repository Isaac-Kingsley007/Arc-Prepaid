# Become a relayer

[All user docs](README.md)

A relayer submits signed payments when their windows open. You pay transaction gas in USDC and receive **70% of each successfully executed payment's tip**, rounded down to USDC's smallest unit. The platform retains the remainder. Failed payments earn no tip, and tips may not cover gas.

## Execute a batch

1. Open the [relayer page](https://arc-prepaid.vercel.app/relayer), connect an EOA wallet on Arc Mainnet, and sign in if requested.
2. Review the due payments, expected tip shares, expiry times and eligibility messages.
3. Choose a batch size from 1 to 10, then choose **Prepare batch**.
4. Review the prepared batch's expected rewards and maximum gas budget. Preparation sends no transaction.
5. Choose **Confirm & execute** and approve the transaction in your wallet.
6. Wait for the receipt and review the executed count, failed count and actual tips earned. Use **View transaction** for the on-chain evidence.

The app checks windows, cancellation, authorization state and payer balances, then simulates and estimates the prepared batch. Those conditions can change before the transaction executes: another relayer may execute first, or a payer may cancel or spend their funds.

Your connected wallet pays gas and receives the relayer tip. If you are also a payer in the batch, your wallet needs enough USDC for both your scheduled transfers and gas. Gas is spent even when a transaction or individual payment fails.

## Reservations and releasing a batch

Prepared payments are reserved for up to ten minutes to reduce duplicate submissions. Choose **Release batch** if you decide not to submit. Unsubmitted reservations eventually expire and become available again.

If there are no ready payments, check again later. Due-payment availability does not guarantee that another relayer has not already claimed or executed them.

## Recover a submitted transaction

If confirmation or database syncing is interrupted, keep the wallet's transaction hash. A timeout does not prove the transaction failed.

- In the same browser, use **Sync transaction** on the submitted-transaction panel. The app retains the hash across reloads when browser storage is available.
- In another browser, connect the same relayer wallet, expand **Sync an existing relayer transaction**, paste its hash, and choose **Sync receipt**.
- If your wallet replaced a transaction, check the replacement hash and the app's recovery message before submitting more work.

Syncing checks existing chain evidence; it does not send another payment transaction. Avoid submitting again just because the page timed out: check the wallet and explorer first. USDC prevents double payment with the same authorization, but duplicate submissions can still waste gas.

## Automated relaying

PrePaid also has a cron relayer configured to run hourly through GitHub Actions. Users do not need to configure that workflow to create payments or use the relayer page.

An enabled cron relayer can execute eligible payments, but GitHub scheduling can be delayed and execution still depends on funding and payment validity. A schedule is not a guarantee of payment at an exact second. Operators can find setup instructions in [MAINNET.md](../MAINNET.md).

Choose **My workspace** to return to the payment app.
