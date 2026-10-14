# Payments and cancellation

[All user docs](README.md)

## Connect and sign in

Open [PrePaid](https://arc-prepaid.vercel.app/), choose **Connect wallet**, and use Arc Mainnet. In **My payments**, choose **Sign message to view payments** if requested, then sign the message in your wallet.

Wallet connection tells the app your address. The sign-in message proves that you control it. Signing in is free and does not authorize a USDC transfer. When your session expires, sign in again with the same wallet to see its schedules.

## Create a schedule

1. Open **New payment** and enter the destination wallet address.
2. Enter the USDC amount per payment and an optional tip per payment. The tip is added to the amount, not deducted from the recipient's payment.
3. Choose the first date and time, then an interval in days, weeks or months.
4. Choose how the schedule ends: a payment count or an end date. One schedule supports up to 50 payments.
5. Review the recipient, dates, amounts and total, then choose **Sign & save**.
6. Confirm the sign-in message if needed, followed by one payment authorization for each occurrence. Wait for the app to finish saving.

Dates use your device's local timezone. Monthly schedules keep the original day where possible and use the last day of shorter months when necessary. Review the generated dates before signing.

Signing and saving send no on-chain transaction. There is no token approval or upfront deposit, and funds are not reserved. Keep enough USDC in your wallet for each payment's amount plus tip when it becomes due.

If saving fails after signing, keep the tab open and choose **Retry saving**. This reuses the existing signed schedule. Unsaved signatures are held in memory, so refreshing or closing the tab loses them. Declining a payment-signing request does not upload a partial schedule.

## When payments happen

Each occurrence opens at its displayed scheduled time and expires 24 hours later, capped at the next occurrence. The exact expiry is shown in **My payments**; execution must happen before it.

A user or cron relayer must submit the payment during that window. Insufficient funds, unavailable relayers or transaction failures can prevent execution. Payments that expire are not automatically moved to another date. See [How PrePaid works](how-it-works.md) for details.

## Read your payment status

Open **My payments**, then expand **Payment dates, amounts and status**. Use **Refresh** to reload the dashboard.

| Status | Meaning |
| --- | --- |
| `pending` | Saved and awaiting execution; the window may not have opened yet. |
| `leased` | Temporarily reserved by a relayer preparing execution. |
| `submitted` | Associated with a transaction whose final result needs confirmation or syncing. |
| `executed` | A confirmed contract event records the payment. |
| `cancelled` | Blocked by a confirmed schedule cancellation. |
| `expired` | Its execution window closed before a successful payment was recorded. |
| `unavailable` | USDC reports the authorization as used or revoked, but the app has not established an execution receipt. |

Statuses are database bookkeeping backed by chain checks. They can lag while receipt syncing is pending. **View transaction** opens the available receipt on the explorer; a successful batch transaction can still contain failed individual payments.

## Cancel remaining payments

1. Connect the wallet that signed the schedule and open **My payments**.
2. Choose **Cancel remaining payments** on that schedule.
3. Review the dialog and choose **Confirm cancellation**.
4. Confirm the transaction in your wallet and wait for confirmation and syncing.

Cancellation costs USDC gas. It is permanent for that schedule and cannot reverse completed payments. A payment that executes before cancellation is included on-chain remains valid. Create a new schedule if you want to restart or change payment details.

Disconnecting your wallet or deleting database records does not cancel signed payments.

### If confirmation or syncing fails

Keep the transaction hash and check it on the explorer. Retry the cancellation control in the same browser: the app retains the submitted hash and can sync its receipt instead of sending another cancellation. On-chain cancellation remains effective even if the dashboard has not updated.

For a cancellation sent elsewhere or from another browser, expand **Already cancelled in another app?**, paste the cancellation transaction hash, and choose **Sync cancellation**. Use the original payer wallet and a transaction for this schedule and contract.
