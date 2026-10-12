"use client";
import { useRef, useState } from "react";
import { useAccount, useConfig, useSignMessage } from "wagmi";
import { getAccount, getWalletClient, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { bytes32, normalizeAddress, toContractPayment, type ChainContext } from "@/lib/db/authorization";
import { prepaidAbi } from "@/lib/prepaid";
import type { RelayerBatch, RelayerCandidate, RelayerResult } from "@/lib/relayer/types";
import type { Hex } from "viem";

type Recovery = { payer: string; transactionHash: Hex; claimToken?: string; originalHash?: Hex };
class RelayerError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
async function api<T>(body?: unknown, path = "/api/relayer"): Promise<T> {
  const response = await fetch(path, { cache: "no-store", method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new RelayerError(result.error || "Request failed. Please retry.", response.status);
  return result;
}
export function useRelayer() {
  const { address, chainId } = useAccount(), config = useConfig(), cache = useQueryClient();
  const { signMessageAsync } = useSignMessage();
  const payer = address ? normalizeAddress(address) : null;
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [progress, setProgress] = useState("");
  const [prepared, setPrepared] = useState<{ payer: string; batch: RelayerBatch } | null>(null);
  const [pending, setPending] = useState<Recovery | null>(null);
  const [outcome, setOutcome] = useState<{ payer: string; result: RelayerResult; hash: Hex } | null>(null);
  const lock = useRef(false);
  const session = useQuery({ queryKey: ["session", payer], enabled: Boolean(payer), retry: false,
    queryFn: () => api<{ payer: string | null }>(undefined, "/api/auth") });
  const authenticated = Boolean(payer && session.data?.payer === payer);
  const discovery = useQuery({ queryKey: ["relayer", payer], enabled: authenticated, retry: false,
    queryFn: () => api<{ context: ChainContext; candidates: RelayerCandidate[] }>(), refetchInterval: 30_000 });
  const saved = useQuery({ queryKey: ["relayer-recovery", payer], enabled: Boolean(payer),
    queryFn: () => {
      try { const value = JSON.parse(localStorage.getItem(`prepaid-relayer:${payer}`) || "null");
        return value?.payer === payer ? { ...value, transactionHash: bytes32(value.transactionHash) } as Recovery : null;
      } catch { return null; }
    } });
  const recovery = pending?.payer === payer ? pending : saved.data ?? null;
  const batch = prepared?.payer === payer ? prepared.batch : null;
  function remember(value: Recovery | null, owner: string) {
    setPending(value);
    try { if (value) localStorage.setItem(`prepaid-relayer:${owner}`, JSON.stringify(value)); else localStorage.removeItem(`prepaid-relayer:${owner}`); } catch { /* Memory recovery remains available. */ }
    void cache.invalidateQueries({ queryKey: ["relayer-recovery", owner] });
  }
  async function ensureWallet(snapshot: Hex) {
    if (getAccount(config).address?.toLowerCase() !== snapshot.toLowerCase()) throw new Error("Wallet changed. Switch back to the wallet that prepared this batch.");
    const client = await getWalletClient(config);
    const [accounts, chain] = await Promise.all([client.getAddresses(), client.getChainId()]);
    if (accounts[0]?.toLowerCase() !== snapshot.toLowerCase() || chain !== 5042002) throw new Error("Use the connected wallet on Arc Testnet.");
  }
  async function run(action: (snapshot: Hex) => Promise<void>) {
    if (lock.current) return;
    if (!address || chainId !== 5042002) { setError("Connect your wallet on Arc Testnet first."); return; }
    lock.current = true; setBusy(true); setError("");
    try { await ensureWallet(address); await action(address); }
    catch (cause) {
      if (cause instanceof RelayerError && cause.status === 401) cache.setQueryData(["session", payer], { payer: null });
      setError((cause instanceof Error ? cause.message.split("\n")[0] : "Could not complete the request.").slice(0, 300));
    }
    finally { lock.current = false; setBusy(false); setProgress(""); }
  }
  async function sync(value: Recovery) {
    const result = await api<RelayerResult>({ action: "sync", transactionHash: value.transactionHash, claimToken: value.claimToken, originalHash: value.originalHash });
    if (!result.pending) { remember(null, value.payer); setPrepared(null); setOutcome({ payer: value.payer, result, hash: value.transactionHash }); }
    await cache.invalidateQueries({ queryKey: ["relayer"] });
    await cache.invalidateQueries({ queryKey: ["schedules"] });
    return result;
  }
  return {
    payer, authenticated: authenticated && !(discovery.error instanceof RelayerError && discovery.error.status === 401), busy, error: error || discovery.error?.message || session.error?.message, progress,
    candidates: discovery.data?.candidates ?? [], loading: authenticated && discovery.isPending,
    batch, recovery, outcome: outcome?.payer === payer ? outcome.result : null,
    outcomeHash: outcome?.payer === payer ? outcome.hash : null,
    refresh: () => discovery.refetch(),
    signIn: () => run(async (snapshot) => {
      setProgress("Sign in with your wallet...");
      const challenge = await api<{ message: string }>({ action: "challenge", payer: snapshot }, "/api/auth");
      const signature = await signMessageAsync({ account: snapshot, message: challenge.message });
      await ensureWallet(snapshot); await api({ action: "verify", signature }, "/api/auth");
      await cache.invalidateQueries({ queryKey: ["session"] });
      await cache.invalidateQueries({ queryKey: ["relayer"] });
    }),
    prepare: (count: number) => run(async (snapshot) => {
      if (batch || recovery) throw new Error("Finish or release the current batch before preparing another.");
      setProgress("Checking signatures, balances and estimated gas...");
      const quote = await api<RelayerBatch>({ action: "claim", count });
      setPrepared({ payer: snapshot.toLowerCase(), batch: quote }); setOutcome(null);
    }),
    release: () => run(async () => {
      if (!batch || recovery) return;
      await api({ action: "release", claimToken: batch.claimToken }); setPrepared(null);
      await cache.invalidateQueries({ queryKey: ["relayer"] });
    }),
    execute: () => run(async (snapshot) => {
      if (!batch || recovery) throw new Error("Prepare a batch first, or sync the submitted transaction.");
      if (Date.now() >= Date.parse(batch.expiresAt) || batch.payments.some((p) => BigInt(p.validBefore) <= BigInt(Math.floor(Date.now() / 1000)))) throw new Error("This batch reservation or payment window expired. Release it and prepare again.");
      const current = await api<ChainContext>(undefined, "/api/payments/config");
      if (current.prepaid !== batch.context.prepaid || current.chainId !== batch.context.chainId) throw new Error("The payment contract changed. Release this batch and refresh.");
      await ensureWallet(snapshot);
      setProgress("Confirm the batch execution and gas fee in your wallet...");
      let hash: Hex;
      try {
        hash = await writeContract(config, { chainId: 5042002, account: snapshot, address: batch.context.prepaid,
          abi: prepaidAbi, functionName: "executePayments", args: [batch.payments.map((p) => toContractPayment({ ...batch.context, payer: p.payer, scheduleId: p.scheduleId }, p))],
          gas: BigInt(batch.gas), maxFeePerGas: BigInt(batch.maxFeePerGas), maxPriorityFeePerGas: BigInt(batch.maxPriorityFeePerGas) });
      } catch (cause) {
        if (/reject|denied/i.test(cause instanceof Error ? cause.message : "")) {
          await api({ action: "release", claimToken: batch.claimToken }); setPrepared(null);
          throw new Error("Wallet request declined. The batch was released.");
        }
        throw new Error("Submission could not be confirmed. Check your wallet activity before retrying; paste any transaction hash below to sync it.");
      }
      let value: Recovery = { payer: snapshot.toLowerCase(), transactionHash: hash, claimToken: batch.claimToken };
      remember(value, value.payer);
      // A browser wallet supplies the hash after broadcasting. Persist it promptly and keep it on errors.
      try { const result = await sync(value); if (!result.pending) return; } catch { /* Receipt recovery still follows. */ }
      setProgress("Waiting for execution confirmation...");
      await waitForTransactionReceipt(config, { chainId: 5042002, hash, confirmations: 1, timeout: 120_000,
        onReplaced: ({ reason, transactionReceipt }) => { value = { ...value, originalHash: reason !== "repriced" ? hash : undefined, transactionHash: transactionReceipt.transactionHash }; remember(value, value.payer); } });
      await ensureWallet(snapshot); setProgress("Syncing each payment result..."); await sync(value);
    }),
    syncTransaction: (hash?: string) => run(async (snapshot) => {
      const value: Recovery = hash?.trim() ? { payer: snapshot.toLowerCase(), transactionHash: bytes32(hash.trim()) } : recovery!;
      if (!value) throw new Error("Enter a transaction hash to sync.");
      setProgress("Checking the transaction receipt...");
      const result = await sync(value);
      if (result.pending) { remember(value, value.payer); setError("The transaction is still pending. Keep its hash and retry syncing; do not submit this batch again."); }
    }),
  };
}
