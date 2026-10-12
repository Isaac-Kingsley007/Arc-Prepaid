import type { ChainContext } from "../db/authorization";
import type { PaymentUpload } from "../payments";

export type RelayerCandidate = {
  id: string; payer: string; payee: string; amount: string; tip: string;
  validBefore: string; reward: string; eligible: boolean; reason: string | null;
};
export type RelayerBatch = {
  context: ChainContext; claimToken: string; ids: string[];
  payments: (PaymentUpload["payments"][number] & { payer: PaymentUpload["payer"]; scheduleId: PaymentUpload["scheduleId"] })[];
  reward: string; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string;
  estimatedCost: string; expiresAt: string;
};
export type RelayerResult = { pending: boolean; executed: number; failed: number; reward: string };
