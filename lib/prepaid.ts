import { parseAbi } from "viem";

/** Shared public ABI for wallet cancellation and server-side verification. */
export const prepaidAbi = parseAbi([
  "function PAYMENT_NONCE_TYPEHASH() view returns (bytes32)",
  "function usdc() view returns (address)",
  "function RELAYER_TIP_PERCENT() view returns (uint256)",
  "function cancelledSchedules(address,bytes32) view returns (bool)",
  "function cancelSchedule(bytes32 scheduleId)",
  "function executePayments((address payer,bytes32 scheduleId,address payee,uint256 amount,uint256 tip,uint256 validAfter,uint256 validBefore,bytes32 salt,uint8 v,bytes32 r,bytes32 s)[] payments) returns (uint256 completed)",
  "event PaymentExecuted(address indexed payer,bytes32 indexed scheduleId,bytes32 indexed nonce,address payee,uint256 amount,uint256 tip,address executor,uint256 relayerTip,uint256 platformTip)",
  "event PaymentFailed(uint256 indexed index,address indexed payer,bytes32 indexed scheduleId,bytes reason)",
  "event ScheduleCancellation(address indexed payer,bytes32 indexed scheduleId)",
]);
