"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { buildSchedule, formatUSDC, initialInput, units, validateInput, type ScheduleInput } from "./schedule";

type IconName = "plus" | "wallet" | "arrow" | "repeat" | "calendar" | "check" | "shield" | "layers" | "close";
function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    wallet: <><path d="M20 8V5H5a2 2 0 0 0 0 4h15v11H5a2 2 0 0 1-2-2V7" /><path d="M20 12h-5v5h5M17 14.5h.01" /></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    repeat: <><path d="m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M16 3v4M8 3v4M3 11h18m-13 5h2m4 0h2" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    layers: <><path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
const dateLabel = (date: Date) => date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const timeLabel = (date: Date) => date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const shorten = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
type Draft = { id: number; input: ScheduleInput };

export default function Home() {
  const [input, setInput] = useState<ScheduleInput>(initialInput);
  const [errors, setErrors] = useState<ReturnType<typeof validateInput>>({});
  const [tab, setTab] = useState<"new" | "drafts">("new");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [review, setReview] = useState<ScheduleInput | null>(null);
  const [notice, setNotice] = useState("");
  const reviewDialog = useRef<HTMLDialogElement>(null);
  const walletDialog = useRef<HTMLDialogElement>(null);
  const schedule = buildSchedule(input);
  const amount = units(input.amount) ?? BigInt(0);
  const tip = units(input.tip) ?? BigInt(0);
  const total = (amount + tip) * BigInt(schedule.dates.length);
  const reviewSchedule = review ? buildSchedule(review) : { dates: [] };

  function update<K extends keyof ScheduleInput>(key: K, value: ScheduleInput[K]) {
    setInput((current) => ({ ...current, [key]: value }));
    setErrors({});
    setNotice("");
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateInput(input);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      const key = Object.keys(nextErrors)[0];
      document.getElementById(key === "schedule" ? "interval" : key)?.focus();
      return;
    }
    setReview({ ...input, payee: input.payee.trim(), label: input.label.trim(), tip: input.tip || "0" });
    reviewDialog.current?.showModal();
  }
  function saveDraft() {
    if (!review) return;
    setDrafts((current) => [...current, { id: Date.now(), input: review }]);
    reviewDialog.current?.close();
    setTab("drafts");
    setNotice("Draft saved for this session. No payment has been signed or scheduled on-chain.");
  }
  return (
    <div className="workspace"><a className="skip-link" href="#main-content">Skip to payment form</a>
      <aside className="sidebar">
        <Link className="brand" href="/" onClick={() => setTab("new")} aria-label="PrePaid home"><span className="brand-mark"><Icon name="repeat" /></span>prepaid<span className="brand-dot">.</span></Link>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          <button className={`nav-item ${tab === "new" ? "active" : ""}`} onClick={() => setTab("new")} aria-current={tab === "new" ? "page" : undefined}><Icon name="plus" />New payment<Icon name="arrow" className="nav-arrow" /></button>
          <button className={`nav-item ${tab === "drafts" ? "active" : ""}`} onClick={() => setTab("drafts")} aria-current={tab === "drafts" ? "page" : undefined}><Icon name="layers" />My drafts<span className="nav-count">{drafts.length}</span></button>
        </nav>
        <div className="sidebar-bottom"><div className="arc-mark">◜</div><p>Good things.<br /><strong>On repeat.</strong></p><span>Recurring payments, powered by Arc.</span><div className="network-label"><span />Arc · USDC</div></div>
      </aside>
      <div className="main-shell">
        <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>{tab === "new" ? "New payment" : "My drafts"}</strong></div><button className="wallet-button" onClick={() => walletDialog.current?.showModal()}><Icon name="wallet" />Connect wallet</button></header>
        <main id="main-content">
          <div className="page-heading"><div><div className="eyebrow"><span />LESS ADMIN. MORE LIFE.</div><h1>{tab === "new" ? "Make it a regular thing." : "A little planning goes a long way."}</h1><p>{tab === "new" ? "Set up a recurring payment. Let the schedule do the remembering." : "Your unsigned payment plans, ready for a second look."}</p></div><span className="preview-badge">UI preview</span></div>
          {notice && <div className="notice" role="status"><Icon name="check" />{notice}</div>}
          {tab === "new" ? <div className="payment-layout">
            <form className="payment-form panel" onSubmit={submit} noValidate>
              <div className="panel-heading"><div className="section-symbol"><Icon name="repeat" /></div><div><h2>New recurring payment</h2><p>A few details now. One less thing later.</p></div></div>
              <section className="form-section"><div className="section-title"><span>01</span><h3>Who are you paying?</h3></div>
                <label htmlFor="payee">Recipient wallet <span className="required">*</span></label>
                <input id="payee" required className="address-input" value={input.payee} onChange={(e) => update("payee", e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" aria-invalid={!!errors.payee} aria-describedby="payee-help" />
                <p id="payee-help" className={errors.payee ? "field-error" : "field-help"}>{errors.payee || "The Arc wallet that will receive each payment."}</p>
                <label htmlFor="label">Payment name <span className="optional">optional</span></label>
                <input id="label" value={input.label} onChange={(e) => update("label", e.target.value)} maxLength={60} placeholder="e.g. Monthly rent, design retainer" />
              </section>
              <section className="form-section"><div className="section-title"><span>02</span><h3>How much, each time?</h3></div>
                <div className="field-grid"><div><label htmlFor="amount">Payment amount <span className="required">*</span></label><div className="input-with-suffix"><input id="amount" required value={input.amount} onChange={(e) => update("amount", e.target.value)} inputMode="decimal" placeholder="0.00" aria-invalid={!!errors.amount} aria-describedby="amount-help" /><span><i className="usdc-symbol">$</i>USDC</span></div><p id="amount-help" className={errors.amount ? "field-error" : "field-help"}>{errors.amount || "Sent to your recipient each time."}</p></div>
                <div><label htmlFor="tip">Tip per payment <span className="optional">optional</span></label><div className="input-with-suffix"><input id="tip" value={input.tip} onChange={(e) => update("tip", e.target.value)} inputMode="decimal" placeholder="0.00" aria-invalid={!!errors.tip} aria-describedby="tip-help" /><span>USDC</span></div><p id="tip-help" className={errors.tip ? "field-error" : "field-help"}>{errors.tip || "An extra amount retained by PrePaid."}</p></div></div>
              </section>
              <section className="form-section schedule-section"><div className="section-title"><span>03</span><h3>Set the rhythm</h3></div>
                <div className="field-grid"><div><label htmlFor="startDate">First payment <span className="required">*</span></label><input id="startDate" required type="date" value={input.startDate} onChange={(e) => update("startDate", e.target.value)} aria-invalid={!!errors.startDate} aria-describedby="start-help" /></div><div><label htmlFor="startTime">Time</label><input id="startTime" required type="time" value={input.startTime} onChange={(e) => update("startTime", e.target.value)} /></div></div>
                <p id="start-help" className={errors.startDate ? "field-error" : "field-help"}>{errors.startDate || "Dates and times use your device’s local timezone."}</p>
                <label htmlFor="interval">Repeat every</label><div className="interval-fields"><input id="interval" type="number" min="1" max="365" value={input.interval} onChange={(e) => update("interval", e.target.value)} aria-describedby="schedule-help" aria-invalid={!!errors.schedule} /><select aria-label="Repeat interval unit" value={input.cadence} onChange={(e) => update("cadence", e.target.value as ScheduleInput["cadence"])}><option value="day">Day{input.interval !== "1" ? "s" : ""}</option><option value="week">Week{input.interval !== "1" ? "s" : ""}</option><option value="month">Month{input.interval !== "1" ? "s" : ""}</option></select><span className="interval-note"><Icon name="repeat" />Your pace. Your plan.</span></div>
                <fieldset className="ending-field"><legend>When does it end?</legend><div className="segmented-control"><label className={input.ending === "count" ? "selected" : ""}><input type="radio" name="ending" value="count" checked={input.ending === "count"} onChange={() => update("ending", "count")} />After a number of payments</label><label className={input.ending === "date" ? "selected" : ""}><input type="radio" name="ending" value="date" checked={input.ending === "date"} onChange={() => update("ending", "date")} />On an end date</label></div>
                  {input.ending === "count" ? <div className="count-input"><label htmlFor="count">Number of payments</label><input id="count" required aria-describedby="schedule-help" type="number" min="1" max="50" value={input.count} onChange={(e) => update("count", e.target.value)} /></div> : <div className="end-date-input"><label htmlFor="endDate">Last payment on or before</label><input id="endDate" required aria-describedby="schedule-help" type="date" value={input.endDate} min={input.startDate || undefined} onChange={(e) => update("endDate", e.target.value)} /></div>}
                </fieldset><p id="schedule-help" className={errors.schedule || schedule.error ? "field-error" : "field-help"} aria-live="polite">{errors.schedule || schedule.error || "Plan up to 50 payments. Monthly dates adjust for shorter months."}</p>
              </section>
              <div className="form-footer"><p><Icon name="shield" />Nothing moves until you sign.</p><button className="primary-button" type="submit">Review payment<Icon name="arrow" /></button></div>
            </form>
            <aside className="preview-column" aria-label="Payment preview">
              <div className="summary-card"><div className="summary-header"><span>YOUR PAYMENT PLAN</span><Icon name="calendar" /></div><div className="summary-amount"><span>{formatUSDC(amount)}</span> <small>USDC</small></div><p className="summary-frequency">Every {input.interval || "—"} {input.cadence}{input.interval !== "1" ? "s" : ""} <span>→</span> {/^0x[0-9a-fA-F]{40}$/.test(input.payee.trim()) ? shorten(input.payee.trim()) : "your recipient"}</p><div className="summary-divider" /><div className="summary-rows"><div><span>Number of payments</span><strong>{schedule.dates.length || "—"}</strong></div><div><span>Total to recipient</span><strong>{formatUSDC(amount * BigInt(schedule.dates.length))} <small>USDC</small></strong></div><div><span>Total tips</span><strong>{formatUSDC(tip * BigInt(schedule.dates.length))} <small>USDC</small></strong></div></div><div className="summary-total"><span>Total planned</span><strong>{formatUSDC(total)} <small>USDC</small></strong></div><p className="summary-footnote">Paid over time. No upfront deposit.</p></div>
              <div className="timeline-card panel"><div className="timeline-heading"><h3>A look ahead</h3><span>{schedule.dates.length ? `${schedule.dates.length} payments` : "Your schedule"}</span></div>{schedule.dates.length ? <><ol className="timeline">{schedule.dates.slice(0, 3).map((date, index) => <li key={date.toISOString()}><span className={`timeline-dot ${index === 0 ? "first" : ""}`}>{index === 0 ? <Icon name="arrow" /> : index + 1}</span><div><strong>{dateLabel(date)}</strong><span>{timeLabel(date)} · Local time</span></div><b>{formatUSDC(amount)}<small>USDC</small></b></li>)}</ol>{schedule.dates.length > 3 && <p className="remaining-payments">+ {schedule.dates.length - 3} more, ending {dateLabel(schedule.dates[schedule.dates.length - 1])}</p>}</> : <div className="timeline-empty"><div className="empty-calendar"><Icon name="calendar" /></div><p>Every good plan starts<br />with a date.</p><span>Choose your first payment to see<br />the schedule take shape.</span></div>}</div>
              <div className="peace-of-mind"><Icon name="shield" /><div><h3>Your money stays yours.</h3><p>Funds stay in your wallet until each payment. You’ll be able to cancel future payments when wallet support is connected.</p></div></div>
            </aside>
          </div> : <section className="draft-section panel"><div className="panel-heading"><div className="section-symbol"><Icon name="layers" /></div><div><h2>My payment drafts</h2><p>Saved in this page session. Refreshing clears these drafts.</p></div></div>{!drafts.length ? <div className="draft-empty"><Icon name="layers" /><h3>A clean slate.</h3><p>Your plans will appear here once you review and save them.</p><button className="primary-button" onClick={() => setTab("new")}><Icon name="plus" />Create a payment</button></div> : <div className="draft-list">{drafts.map((draft) => <article className="draft-item" key={draft.id}><div className="draft-icon"><Icon name="repeat" /></div><div className="draft-detail"><h3>{draft.input.label || "Recurring payment"}<span className="draft-badge">Unsigned draft</span></h3><p>{shorten(draft.input.payee)} · {buildSchedule(draft.input).dates.length} payments · Every {draft.input.interval} {draft.input.cadence}{draft.input.interval !== "1" ? "s" : ""}</p></div><strong>{formatUSDC(units(draft.input.amount)!)} <small>USDC</small></strong><div className="draft-actions"><button className="text-button" onClick={() => { setInput({ ...draft.input }); setErrors({}); setNotice(""); setTab("new"); }}>Use details</button><button className="text-button danger" onClick={() => { setDrafts((current) => current.filter((item) => item.id !== draft.id)); setNotice("Draft discarded. No on-chain payment was cancelled."); }}>Discard</button></div></article>)}</div>}</section>}
          <footer className="page-footer"><span>Built for life on repeat.</span><span>Powered by <strong>Arc</strong><span className="footer-dot">·</span>Payments in USDC</span></footer>
        </main>
      </div>
      <dialog ref={reviewDialog} className="review-dialog" aria-labelledby="review-title"><div className="dialog-content"><button className="close-button" aria-label="Close review" onClick={() => reviewDialog.current?.close()}><Icon name="close" /></button><span className="dialog-icon"><Icon name="check" /></span><div className="eyebrow">LOOKING GOOD</div><h2 id="review-title">One last look.</h2><p className="dialog-intro">Review your plan before saving an unsigned draft.</p>{review && <><div className="review-recipient"><span>{review.label || "Recurring payment"}</span><code>{review.payee}</code></div><dl className="review-details"><div><dt>Each payment</dt><dd>{formatUSDC(units(review.amount)!)} USDC</dd></div><div><dt>Tip per payment</dt><dd>{formatUSDC(units(review.tip)!)} USDC</dd></div><div><dt>Repeat</dt><dd>Every {review.interval} {review.cadence}{review.interval !== "1" ? "s" : ""}</dd></div><div><dt>First payment</dt><dd>{reviewSchedule.dates[0] && dateLabel(reviewSchedule.dates[0])}<br /><small>{reviewSchedule.dates[0] && timeLabel(reviewSchedule.dates[0])} · Local time</small></dd></div><div><dt>Last payment</dt><dd>{reviewSchedule.dates.length > 0 && dateLabel(reviewSchedule.dates[reviewSchedule.dates.length - 1])}</dd></div><div className="review-total"><dt>{reviewSchedule.dates.length} payments · total with tips</dt><dd>{formatUSDC((units(review.amount)! + units(review.tip)!) * BigInt(reviewSchedule.dates.length))} USDC</dd></div></dl><details className="all-dates"><summary>View all payment dates</summary><ol>{reviewSchedule.dates.map((date) => <li key={date.toISOString()}>{dateLabel(date)} <span>{timeLabel(date)}</span></li>)}</ol></details></>}<p className="local-note">Preview only. Saving a draft does not connect a wallet, sign an authorization, or create an on-chain payment. Execution windows will be configured when signing is added.</p><div className="dialog-actions"><button className="secondary-button" onClick={() => reviewDialog.current?.close()}>Keep editing</button><button className="primary-button" onClick={saveDraft}>Save draft<Icon name="arrow" /></button></div></div></dialog>
      <dialog ref={walletDialog} className="wallet-dialog" aria-labelledby="wallet-title"><div className="dialog-content"><button className="close-button" aria-label="Close wallet information" onClick={() => walletDialog.current?.close()}><Icon name="close" /></button><span className="dialog-icon"><Icon name="wallet" /></span><h2 id="wallet-title">Wallet support is next.</h2><p className="dialog-intro">You can build and review your payment plan now. Connecting a wallet, signing payments, and on-chain cancellation will be available in the next step.</p><button className="primary-button full-width" onClick={() => walletDialog.current?.close()}>Start with a plan<Icon name="arrow" /></button></div></dialog>
    </div>
  );
}
