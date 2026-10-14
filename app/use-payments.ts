"use client";
import { arcChain } from "@/lib/network";
import { useRef, useState } from "react";
import { useAccount, useConfig, useSignMessage, useSignTypedData } from "wagmi";
import { getAccount, getWalletClient, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authorizationMessage, attachSignature, preparePayments, type DashboardSchedule, type PaymentUpload } from "../lib/payments";
import { normalizeAddress, verifyPaymentSignature, type ChainContext } from "../lib/db/authorization";
import type { ScheduleInput } from "./schedule";
import { prepaidAbi } from "../lib/prepaid";
import { bytes32 } from "../lib/db/authorization";
import type { Hex } from "viem";

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed. Please retry.");
  return result;
}
export function usePayments() {
  const { address, chainId } = useAccount(), config = useConfig(), cache = useQueryClient();
  const { signMessageAsync } = useSignMessage(), { signTypedDataAsync } = useSignTypedData();
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PaymentUpload | null>(null);
  const [cancellation, setCancellation] = useState<{ payer: string; hash?: Hex; message: string } | null>(null);
  const cancellationHashes = useRef(new Map<string, Hex>());
  const [pagination, setPagination] = useState<{ payer: string | null; offset: number }>({ payer: null, offset: 0 });
  const lock = useRef(false);
  const payer = address ? normalizeAddress(address) : null;
  const offset = pagination.payer === payer ? pagination.offset : 0;
  const setOffset = (value: number) => setPagination({ payer, offset: value });
  const session = useQuery({ queryKey: ["session", payer], enabled: Boolean(payer), retry: false,
    queryFn: () => api<{ payer: string | null }>("/api/auth"), staleTime: 60_000 });
  const authenticated = Boolean(payer && session.data?.payer === payer);
  const dashboard = useQuery({ queryKey: ["schedules", payer, offset], enabled: authenticated, retry: false,
    queryFn: () => api<{ payer: string; schedules: DashboardSchedule[]; nextOffset: number | null }>(`/api/schedules?offset=${offset}`),
    refetchInterval: 30_000 });
  async function ensureWallet(snapshot: string) {
    if (getAccount(config).address?.toLowerCase() !== snapshot.toLowerCase()) throw new Error("Wallet changed. Please retry with the original wallet.");
    const wallet = await getWalletClient(config);
    const [accounts, currentChain] = await Promise.all([wallet.getAddresses(), wallet.getChainId()]);
    if (accounts[0]?.toLowerCase() !== snapshot.toLowerCase()) throw new Error("Wallet account changed.");
    if (currentChain !== arcChain.id) throw new Error(`Switch your wallet to ${arcChain.name} first.`);
  }
  async function authenticate(snapshot: string) {
    await ensureWallet(snapshot);
    const current = await api<{ payer: string | null }>("/api/auth");
    if (current.payer !== snapshot.toLowerCase()) {
      setProgress("Sign in to view and save your payments…");
      const challenge = await api<{ message: string }>("/api/auth", { action: "challenge", payer: snapshot });
      const signature = await signMessageAsync({ message: challenge.message, account: snapshot as `0x${string}` });
      await ensureWallet(snapshot);
      await api("/api/auth", { action: "verify", signature });
    }
    await cache.invalidateQueries({ queryKey: ["session"] });
    await cache.invalidateQueries({ queryKey: ["schedules"] });
  }
  async function run(action: (snapshot: `0x${string}`) => Promise<void>) {
    if (lock.current) return false;
    if (!address) { setError("Connect your wallet first."); return false; }
    if (chainId !== arcChain.id) { setError(`Switch your wallet to ${arcChain.name} first.`); return false; }
    lock.current = true; setBusy(true); setError("");
    try { await action(address); return true; }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not finish. Please retry.";
      setError(/reject|denied/i.test(message) ? "Wallet request declined. No new transaction or schedule was submitted." : message.split("\n")[0].slice(0, 250));
      return false;
    } finally { lock.current = false; setBusy(false); setProgress(""); }
  }
  async function save(upload: PaymentUpload, snapshot: string) {
    await ensureWallet(snapshot);
    setProgress("Saving your signed payments…");
    await api("/api/schedules", upload);
    setPending(null); setOffset(0);
    await cache.invalidateQueries({ queryKey: ["schedules"] });
  }
  const retryUpload = pending?.payer === payer ? pending : null;
  async function cancelSchedule(scheduleId: Hex, providedHash?: string) {
    return run(async (snapshot) => {
      await authenticate(snapshot);
      const context = await api<ChainContext>("/api/payments/config");
      const storageKey = `prepaid-cancellation:${context.chainId}:${context.prepaid}:${snapshot.toLowerCase()}:${scheduleId}`;
      const remember = (hash?: Hex) => {
        if (hash) cancellationHashes.current.set(storageKey, hash); else cancellationHashes.current.delete(storageKey);
        try { if (hash) localStorage.setItem(storageKey, hash); else localStorage.removeItem(storageKey); } catch { /* In-memory recovery still works when browser storage is unavailable. */ }
      };
      let hash = providedHash?.trim() ? bytes32(providedHash.trim()) : cancellationHashes.current.get(storageKey);
      if (!hash) {
        try { const stored = localStorage.getItem(storageKey); if (stored) hash = bytes32(stored); } catch { /* Ignore unavailable or malformed local recovery data. */ }
      }
      if (!hash) {
        setProgress("Checking whether this schedule is already cancelled...");
        const existing = await api<{ cancelled: boolean; transactionHash?: Hex }>("/api/schedules/cancel", { scheduleId });
        if (existing.cancelled) {
          setCancellation({ payer: snapshot.toLowerCase(), hash: existing.transactionHash, message: "Cancellation confirmed and synced. Remaining payments are blocked." });
          await cache.invalidateQueries({ queryKey: ["schedules"] }); return;
        }
        await ensureWallet(snapshot);
        setProgress("Confirm cancellation in your wallet. This transaction uses USDC for gas...");
        hash = await writeContract(config, { chainId: arcChain.id, account: snapshot, address: context.prepaid,
          abi: prepaidAbi, functionName: "cancelSchedule", args: [scheduleId] });
        remember(hash);
        setCancellation({ payer: snapshot.toLowerCase(), hash, message: "Cancellation submitted. If confirmation or syncing fails, retry with this transaction." });
      }
      setProgress("Waiting for cancellation confirmation...");
      let replaced = false;
      const receipt = await waitForTransactionReceipt(config, { chainId: arcChain.id, hash, confirmations: 1, timeout: 120_000,
        onReplaced: ({ reason, transactionReceipt }) => {
          hash = transactionReceipt.transactionHash;
          replaced = reason !== "repriced";
          remember(replaced ? undefined : hash);
          setCancellation({ payer: snapshot.toLowerCase(), hash, message: replaced ? "Your wallet replaced the cancellation transaction. Check it before retrying." : "Waiting to sync the replacement cancellation transaction." });
        } });
      if (receipt.status !== "success" || replaced) {
        remember();
        throw new Error(replaced ? "Cancellation was replaced by another transaction. Retry to check the schedule and cancel again if needed." : "Cancellation reverted. Your schedule was not cancelled. You can retry.");
      }
      hash = receipt.transactionHash; remember(hash);
      await ensureWallet(snapshot);
      setProgress("Verifying cancellation and syncing your payments...");
      await api("/api/schedules/cancel", { scheduleId, transactionHash: hash });
      remember();
      setCancellation({ payer: snapshot.toLowerCase(), hash, message: "Cancellation confirmed and synced. Remaining payments are blocked. Payments already executed are unchanged." });
      await cache.invalidateQueries({ queryKey: ["schedules"] });
    });
  }
  return {
    busy, progress, error, authenticated, payer, retryUpload,
    cancelSchedule, cancellation: cancellation?.payer === payer ? cancellation : null,
    schedules: authenticated && dashboard.data?.payer === payer ? dashboard.data.schedules : [],
    loading: authenticated && dashboard.isPending,
    dashboardError: authenticated ? dashboard.error?.message : session.error?.message,
    nextOffset: dashboard.data?.nextOffset ?? null, offset, setOffset,
    refresh: () => dashboard.refetch(),
    signIn: () => run(async (snapshot) => { await authenticate(snapshot); }),
    signAndSave: (input: ScheduleInput) => run(async (snapshot) => {
      if (retryUpload) throw new Error("Retry saving your already signed schedule before creating another one.");
      await authenticate(snapshot);
      setProgress("Checking the payment contract…");
      const context = await api<ChainContext>("/api/payments/config");
      await ensureWallet(snapshot);
      const upload = preparePayments(input, context, normalizeAddress(snapshot));
      for (let i = 0; i < upload.payments.length; i++) {
        await ensureWallet(snapshot);
        setProgress(`Sign payment ${i + 1} of ${upload.payments.length} in your wallet…`);
        const signature = await signTypedDataAsync({ ...authorizationMessage(upload, upload.payments[i]), account: snapshot });
        await ensureWallet(snapshot);
        const signed = attachSignature(upload.payments[i], signature);
        await verifyPaymentSignature(upload, signed);
        upload.payments[i] = signed;
      }
      setPending(upload);
      await save(upload, snapshot);
    }),
    retrySave: () => run(async (snapshot) => {
      if (!retryUpload) throw new Error("There is no signed schedule to retry.");
      await authenticate(snapshot); await save(retryUpload, snapshot);
    }),
  };
}
