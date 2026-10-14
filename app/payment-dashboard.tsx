"use client";
import { arcChain } from "@/lib/network";
import type { usePayments } from "./use-payments";
import { formatUSDC } from "./schedule";
import { useRef, useState } from "react";
import type { DashboardSchedule } from "../lib/payments";

export default function PaymentDashboard({ payments }: { payments: ReturnType<typeof usePayments> }) {
  const [selected, setSelected] = useState<DashboardSchedule | null>(null);
  const [transactionHash, setTransactionHash] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  return <section className="min-h-100 rounded-[13px] border border-border bg-white shadow-[0_4px_20px_#29224d03]">
    <div className="flex items-center justify-between gap-3 border-b border-border px-7 py-6">
      <div><h2 className="text-[15px] font-semibold">My payments</h2><p className="mt-1 text-xs text-[#73677f]">Signed schedules saved for your connected wallet.</p></div>
      {payments.authenticated && <button className="rounded-lg px-3 py-2 text-xs text-primary hover:bg-[#f5f3fc]" onClick={() => void payments.refresh()}>Refresh</button>}
    </div>
    {!payments.authenticated ? <div className="px-5 py-16 text-center">
      <h3 className="text-base font-semibold">{payments.payer ? "Wallet connected. One more step." : "Connect your wallet to get started."}</h3>
      <p id="payment-sign-in-help" className="mx-auto mt-3 max-w-md text-sm leading-6 text-[#73677f]">{payments.payer ? "To view your saved payments, click below and sign a message in your wallet to confirm it belongs to you." : "Use Connect wallet at the top of the page. Then confirm ownership with a sign-in message to view your saved payments."}</p>
      <p className="mb-5 mt-2 text-xs leading-5 text-[#73677f]">Signing in is free and does not authorize a payment or move funds.</p>
      <button disabled={payments.busy || !payments.payer} aria-describedby="payment-sign-in-help" className="rounded-lg bg-primary px-5 py-3 text-xs text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary disabled:opacity-50" onClick={() => void payments.signIn()}>{payments.busy ? "Check your wallet..." : "Sign message to view payments"}</button>
    </div>
      : payments.loading ? <p className="p-7 text-sm text-[#73677f]">Loading your payments…</p>
      : !payments.schedules.length && !payments.dashboardError ? <p className="px-5 py-16 text-center text-sm text-[#73677f]">Your signed payments will appear here.</p> : null}
    {payments.dashboardError && <div className="p-7 text-sm text-red-700"><p role="alert">{payments.dashboardError}</p><button disabled={payments.busy || !payments.payer} className="mt-3 text-xs text-primary underline" onClick={() => void payments.signIn()}>Sign in and retry</button></div>}
    {payments.cancellation && <div role="status" className="mx-7 mt-5 rounded-lg bg-[#f8f6fc] p-4 text-xs text-[#73677f]">{payments.cancellation.message} {payments.cancellation.hash && <a className="text-primary underline" target="_blank" rel="noreferrer" href={`${arcChain.blockExplorers.default.url}/tx/${payments.cancellation.hash}`}>View transaction</a>}</div>}
    {payments.schedules.map((schedule) => <article key={schedule.scheduleId} className="border-b border-border p-7 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{schedule.label || "Recurring payment"}</h3><span className="rounded bg-[#f6f2fc] px-2 py-1 text-xs text-[#73677f]">{schedule.cancelled ? "Cancelled" : `${schedule.payments.length} signed payments`}</span></div>
      <p className="mt-2 break-all text-xs text-[#73677f]">To {schedule.payments[0]?.payee}</p>
      <p className="mt-2 break-all text-xs text-[#73677f]">Schedule ID: {schedule.scheduleId}</p>
      {!schedule.cancelled && <button disabled={payments.busy} className="mt-4 rounded-lg border border-border px-3 py-2 text-xs text-primary hover:bg-[#f5f3fc] disabled:opacity-50" onClick={() => { setSelected(schedule); setTransactionHash(""); dialog.current?.showModal(); }}>Cancel remaining payments</button>}
      <details className="mt-4 text-xs text-[#73677f]"><summary className="cursor-pointer">Payment dates, amounts and status</summary><ol className="mt-3 grid gap-3">
        {schedule.payments.map((payment) => <li key={payment.occurrence} className="flex flex-wrap justify-between gap-2 rounded-lg bg-[#f8f6fc] p-3">
          <span>{new Date((Number(payment.validAfter) + 1) * 1000).toLocaleString()}<br /><span className="text-[11px]">Expires {new Date(Number(payment.validBefore) * 1000).toLocaleString()}</span></span>
          <span>{formatUSDC(BigInt(payment.amount))} USDC + {formatUSDC(BigInt(payment.tip))} tip<br /><span>{payment.status}</span></span>
          {payment.transactionHash && <a className="text-primary underline" href={`${arcChain.blockExplorers.default.url}/tx/${payment.transactionHash}`} target="_blank" rel="noreferrer">View transaction</a>}
        </li>)}
      </ol></details>
    </article>)}
    {payments.authenticated && <div className="flex justify-between p-5 text-xs text-primary"><button disabled={payments.offset === 0} className="disabled:opacity-40" onClick={() => payments.setOffset(Math.max(0, payments.offset - 20))}>Previous</button><button disabled={payments.nextOffset === null} className="disabled:opacity-40" onClick={() => payments.nextOffset !== null && payments.setOffset(payments.nextOffset)}>Next</button></div>}
    <dialog ref={dialog} onCancel={(event) => { if (payments.busy) event.preventDefault(); }} className="m-auto w-[min(460px,calc(100%-32px))] rounded-2xl border border-border bg-white p-7 text-foreground shadow-xl backdrop:bg-[#25203970]" aria-labelledby="cancel-title">
      <h2 id="cancel-title" className="text-lg font-semibold">Cancel remaining payments?</h2>
      <p className="mt-3 text-sm text-[#73677f]">{selected?.label || "This schedule"} will be permanently cancelled. Payments already executed cannot be undone. Your wallet will submit one transaction, with gas paid in USDC.</p>
      <details className="mt-4 text-xs text-[#73677f]"><summary className="cursor-pointer">Already cancelled in another app?</summary><label htmlFor="cancellation-hash" className="mt-3 block">Cancellation transaction hash</label><input id="cancellation-hash" value={transactionHash} onChange={(event) => setTransactionHash(event.target.value)} disabled={payments.busy} placeholder="0x..." className="mt-2 w-full rounded-lg border border-border p-3" /><p className="mt-2">Paste the hash to sync an older cancellation without sending another transaction.</p></details>
      <p role={payments.error ? "alert" : "status"} className="mt-4 text-xs text-[#73677f]">{payments.error || payments.progress}</p>
      <div className="mt-6 flex justify-end gap-3"><button disabled={payments.busy} className="rounded-lg border border-border px-4 py-3 text-xs disabled:opacity-50" onClick={() => dialog.current?.close()}>Keep payments</button><button disabled={payments.busy || !selected} className="rounded-lg bg-primary px-4 py-3 text-xs text-white disabled:opacity-50" onClick={async () => { if (selected && await payments.cancelSchedule(selected.scheduleId, transactionHash)) dialog.current?.close(); }}>{payments.busy ? "Please wait..." : transactionHash.trim() ? "Sync cancellation" : "Confirm cancellation"}</button></div>
    </dialog>
  </section>;
}
