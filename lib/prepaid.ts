import { parseAbi } from "viem";

/** Shared public ABI for wallet cancellation and server-side verification. */
export const prepaidAbi = parseAbi([
  "function PAYMENT_NONCE_TYPEHASH() view returns (bytes32)",
  "function usdc() view returns (address)",
  "function RELAYER_TIP_PERCENT() view returns (uint256)",
  "function cancelledSchedules(address,bytes32) view returns (bool)",
  "function cancelSchedule(bytes32 scheduleId)",
  "event ScheduleCancellation(address indexed payer,bytes32 indexed scheduleId)",
]);
