import "server-only";
import { decodeEventLog, TransactionReceiptNotFoundError, type Hex, type TransactionReceipt } from "viem";
import { prepaidAbi } from "../prepaid";
import type { ScheduleKey } from "../db/authorization";
import { arcClient } from "./config";
import { ApiError } from "./http";

export function cancellationProof(receipt: TransactionReceipt, key: ScheduleKey) {
  if (receipt.status !== "success") throw new ApiError("Cancellation transaction reverted. Your schedule was not cancelled.", 409);
  const matching = receipt.logs.some((log) => {
    if (log.removed || log.address.toLowerCase() !== key.prepaid) return false;
    try {
      const event = decodeEventLog({ abi: prepaidAbi, data: log.data, topics: log.topics, strict: true });
      return event.eventName === "ScheduleCancellation" && event.args.payer.toLowerCase() === key.payer
        && event.args.scheduleId === key.scheduleId;
    } catch { return false; }
  });
  if (!matching) throw new ApiError("This transaction does not cancel this schedule for your wallet.");
  return { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash };
}

/** Independently reads chain evidence; browser-supplied status and block details are never accepted. */
export async function confirmedCancellation(key: ScheduleKey, hash: Hex, client = arcClient()) {
  let receipt;
  try { receipt = await client.getTransactionReceipt({ hash }); }
  catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) throw new ApiError("Cancellation is not confirmed yet. Wait, then retry syncing.", 409);
    throw error;
  }
  if (receipt.transactionHash !== hash) throw new ApiError("Cancellation receipt does not match the transaction.");
  const proof = cancellationProof(receipt, key);
  const [block, cancelled] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }),
    client.readContract({ address: key.prepaid, abi: prepaidAbi, functionName: "cancelledSchedules", args: [key.payer, key.scheduleId] }),
  ]);
  if (block.hash !== receipt.blockHash || !cancelled) throw new ApiError("Cancellation is not confirmed on the configured chain.", 409);
  return proof;
}

/** Recover a recent cancellation made elsewhere; Arc limits each log request to 10,000 blocks. */
export async function recentCancellationHash(key: ScheduleKey, client = arcClient()): Promise<Hex | null> {
  const latest = await client.getBlockNumber();
  const logs = await client.getLogs({ address: key.prepaid,
    event: prepaidAbi.find((item) => item.type === "event" && item.name === "ScheduleCancellation")!,
    args: { payer: key.payer, scheduleId: key.scheduleId },
    fromBlock: latest > BigInt(9998) ? latest - BigInt(9998) : BigInt(0), toBlock: latest, strict: true });
  return logs.find((log) => !log.removed)?.transactionHash ?? null;
}
