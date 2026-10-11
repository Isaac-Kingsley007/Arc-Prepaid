"use client";
import type { usePayments } from "./use-payments";
import { formatUSDC } from "./schedule";

export default function PaymentDashboard({ payments }: { payments: ReturnType<typeof usePayments> }) {
  return <section className="min-h-100 rounded-[13px] border border-border bg-white shadow-[0_4px_20px_#29224d03]">
    <div className="flex items-center justify-between gap-3 border-b border-border px-7 py-6">
      <div><h2 className="text-[15px] font-semibold">My payments</h2><p className="mt-1 text-xs text-[#73677f]">Signed schedules saved for your connected wallet.</p></div>
      {payments.authenticated && <button className="rounded-lg px-3 py-2 text-xs text-primary hover:bg-[#f5f3fc]" onClick={() => void payments.refresh()}>Refresh</button>}
    </div>
    {!payments.authenticated ? <div className="px-5 py-16 text-center"><p className="mb-5 text-sm text-[#73677f]">{payments.payer ? "Sign in to see your saved payments." : "Connect your wallet to see your payments."}</p><button disabled={payments.busy || !payments.payer} className="rounded-lg bg-primary px-5 py-3 text-xs text-white disabled:opacity-50" onClick={() => void payments.signIn()}>Sign in with wallet</button></div>
      : payments.loading ? <p className="p-7 text-sm text-[#73677f]">Loading your payments…</p>
      : !payments.schedules.length && !payments.dashboardError ? <p className="px-5 py-16 text-center text-sm text-[#73677f]">Your signed payments will appear here.</p> : null}
    {payments.dashboardError && <div className="p-7 text-sm text-red-700"><p role="alert">{payments.dashboardError}</p><button disabled={payments.busy || !payments.payer} className="mt-3 text-xs text-primary underline" onClick={() => void payments.signIn()}>Sign in and retry</button></div>}
    {payments.schedules.map((schedule) => <article key={schedule.scheduleId} className="border-b border-border p-7 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{schedule.label || "Recurring payment"}</h3><span className="rounded bg-[#f6f2fc] px-2 py-1 text-xs text-[#73677f]">{schedule.cancelled ? "Cancelled" : `${schedule.payments.length} signed payments`}</span></div>
      <p className="mt-2 break-all text-xs text-[#73677f]">To {schedule.payments[0]?.payee}</p>
      <p className="mt-2 break-all text-xs text-[#73677f]">Schedule ID: {schedule.scheduleId}</p>
      <details className="mt-4 text-xs text-[#73677f]"><summary className="cursor-pointer">Payment dates, amounts and status</summary><ol className="mt-3 grid gap-3">
        {schedule.payments.map((payment) => <li key={payment.occurrence} className="flex flex-wrap justify-between gap-2 rounded-lg bg-[#f8f6fc] p-3">
          <span>{new Date((Number(payment.validAfter) + 1) * 1000).toLocaleString()}<br /><span className="text-[11px]">Expires {new Date(Number(payment.validBefore) * 1000).toLocaleString()}</span></span>
          <span>{formatUSDC(BigInt(payment.amount))} USDC + {formatUSDC(BigInt(payment.tip))} tip<br /><span>{payment.status}</span></span>
          {payment.transactionHash && <a className="text-primary underline" href={`https://explorer.testnet.arc.io/tx/${payment.transactionHash}`} target="_blank" rel="noreferrer">View transaction</a>}
        </li>)}
      </ol></details>
    </article>)}
    {payments.authenticated && <div className="flex justify-between p-5 text-xs text-primary"><button disabled={payments.offset === 0} className="disabled:opacity-40" onClick={() => payments.setOffset(Math.max(0, payments.offset - 20))}>Previous</button><button disabled={payments.nextOffset === null} className="disabled:opacity-40" onClick={() => payments.nextOffset !== null && payments.setOffset(payments.nextOffset)}>Next</button></div>}
  </section>;
}
