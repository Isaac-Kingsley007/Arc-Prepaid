// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUSDC} from "./interfaces/IUSDC.sol";

/// @title PrePaid
/// @notice Stores future USDC authorizations; receives and forwards a payment atomically.
/// @dev Payers register their own immutable forwarding instructions. Funds remain in
/// their wallet until execution. All amounts use USDC's six-decimal ERC-20 units.
contract PrePaid is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_SCHEDULE_PAYMENTS = 50;
    uint256 public constant MAX_BATCH_SIZE = 50;
    uint256 public constant MAX_PAGE_SIZE = 100;
    uint256 public constant PAYMENT_CALL_GAS = 300_000;
    uint256 private constant BATCH_GAS_RESERVE = 60_000;
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    IUSDC public immutable usdc;
    uint256 public nextScheduleId = 1;
    uint256 public nextPaymentId = 1;
    /// @notice Only tips from successfully completed payments; excludes direct donations.
    uint256 public accruedTips;

    struct PaymentInput {
        address payee;
        uint256 amount;
        uint256 tip;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct Schedule {
        address payer;
        uint256 firstPaymentId;
        uint256 paymentCount;
        bool cancelled;
    }

    struct Payment {
        uint256 scheduleId;
        address payee;
        uint256 amount;
        uint256 tip;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
        bool executed;
    }

    enum PaymentState { Unknown, Pending, Ready, Executed, Cancelled, Expired }

    mapping(uint256 scheduleId => Schedule) public schedules;
    mapping(uint256 paymentId => Payment) private _payments;
    mapping(address payer => uint256[]) private _payerSchedules;
    /// @dev Reservations are permanent, including after cancellation: no replay by re-registration.
    mapping(address payer => mapping(bytes32 nonce => bool)) public nonceRegistered;

    error InvalidUSDC();
    error InvalidBatchSize();
    error InvalidPayment(uint256 index);
    error InvalidSignature(uint256 index);
    error NonceUnavailable(bytes32 nonce);
    error UnknownSchedule(uint256 scheduleId);
    error NotSchedulePayer();
    error ScheduleAlreadyCancelled();
    error PaymentNotExecutable(uint256 paymentId, PaymentState state);
    error OnlySelf();
    error InvalidRecipient();
    error NoTips();
    error UnexpectedUSDCBalance();
    error InsufficientBatchGas(uint256 paymentId);

    event ScheduleCreated(uint256 indexed scheduleId, address indexed payer, uint256 firstPaymentId, uint256 paymentCount);
    event PaymentRegistered(
        uint256 indexed paymentId, uint256 indexed scheduleId, address indexed payee,
        uint256 amount, uint256 tip, uint256 validAfter, uint256 validBefore, bytes32 nonce
    );
    event ScheduleCancelled(uint256 indexed scheduleId, address indexed payer);
    event PaymentExecuted(
        uint256 indexed paymentId, uint256 indexed scheduleId, address indexed payee,
        uint256 amount, uint256 tip, address executor
    );
    event PaymentSkipped(uint256 indexed paymentId, PaymentState state);
    event PaymentFailed(uint256 indexed paymentId, bytes reason);
    event TipsWithdrawn(address indexed recipient, uint256 amount);

    /// @param usdcAddress Arc testnet and mainnet use 0x3600000000000000000000000000000000000000.
    /// @dev Interface calls, rather than code-length checks, support Arc system contracts.
    constructor(address usdcAddress) Ownable(msg.sender) {
        if (usdcAddress == address(0)) revert InvalidUSDC();
        IUSDC token = IUSDC(usdcAddress);
        if (token.decimals() != 6 || token.DOMAIN_SEPARATOR() == bytes32(0)) revert InvalidUSDC();
        usdc = token;
    }

    /// @notice Payer submits one transaction storing a schedule and its USDC signatures.
    /// @dev Each signature authorizes payer -> this contract for amount + tip.
    /// msg.sender binds the unsigned forwarding instructions to the payer's transaction.
    /// Never accept arbitrary callers submitting someone else's plain USDC signatures here.
    function createSchedule(PaymentInput[] calldata inputs) external nonReentrant returns (uint256 scheduleId) {
        uint256 count = inputs.length;
        if (count == 0 || count > MAX_SCHEDULE_PAYMENTS) revert InvalidBatchSize();
        bytes32 domainSeparator = usdc.DOMAIN_SEPARATOR();
        scheduleId = nextScheduleId++;
        uint256 firstPaymentId = nextPaymentId;
        schedules[scheduleId] = Schedule(msg.sender, firstPaymentId, count, false);
        _payerSchedules[msg.sender].push(scheduleId);

        for (uint256 i; i < count; ++i) {
            PaymentInput calldata input = inputs[i];
            if (
                input.payee == address(0) || input.payee == address(this) || input.payee == address(usdc)
                    || input.amount == 0 || input.validAfter >= input.validBefore
                    || input.validBefore <= block.timestamp
            ) revert InvalidPayment(i);

            if (nonceRegistered[msg.sender][input.nonce] || usdc.authorizationState(msg.sender, input.nonce)) {
                revert NonceUnavailable(input.nonce);
            }
            bytes32 structHash = keccak256(abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH, msg.sender, address(this), input.amount + input.tip,
                input.validAfter, input.validBefore, input.nonce
            ));
            bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
            if (!SignatureChecker.isValidSignatureNow(msg.sender, digest, abi.encodePacked(input.r, input.s, input.v))) {
                revert InvalidSignature(i);
            }

            nonceRegistered[msg.sender][input.nonce] = true;
            uint256 paymentId = nextPaymentId++;
            _payments[paymentId] = Payment({
                scheduleId: scheduleId, payee: input.payee, amount: input.amount, tip: input.tip,
                validAfter: input.validAfter, validBefore: input.validBefore, nonce: input.nonce,
                v: input.v, r: input.r, s: input.s, executed: false
            });
            emit PaymentRegistered(paymentId, scheduleId, input.payee, input.amount, input.tip, input.validAfter, input.validBefore, input.nonce);
        }
        emit ScheduleCreated(scheduleId, msg.sender, firstPaymentId, count);
    }

    /// @notice One payer transaction cancels every unexecuted payment in a schedule, without a loop.
    /// @dev No USDC cancellation signatures are needed: only this contract can receive these authorizations.
    function cancelSchedule(uint256 scheduleId) external nonReentrant {
        Schedule storage schedule = schedules[scheduleId];
        if (schedule.payer == address(0)) revert UnknownSchedule(scheduleId);
        if (schedule.payer != msg.sender) revert NotSchedulePayer();
        if (schedule.cancelled) revert ScheduleAlreadyCancelled();
        schedule.cancelled = true;
        emit ScheduleCancelled(scheduleId, msg.sender);
    }

    /// @notice Anyone, including the cron relayer, may execute a single ready payment.
    function executePayment(uint256 paymentId) external nonReentrant {
        _execute(paymentId, msg.sender);
    }

    /// @notice Executes ready IDs; skips non-ready IDs and isolates each failed payment.
    /// @dev Returns the count completed and the number of input IDs processed. Insufficient
    /// outer gas reverts the batch so gas estimation cannot succeed without attempting ready items.
    function executePayments(uint256[] calldata paymentIds) external nonReentrant returns (uint256 completed, uint256 processed) {
        if (paymentIds.length == 0 || paymentIds.length > MAX_BATCH_SIZE) revert InvalidBatchSize();
        for (; processed < paymentIds.length; ++processed) {
            uint256 paymentId = paymentIds[processed];
            PaymentState state = getPaymentState(paymentId);
            if (state != PaymentState.Ready) {
                emit PaymentSkipped(paymentId, state);
                continue;
            }
            // Reserve gas for EIP-150 forwarding, failure handling, and the next iteration.
            if (gasleft() < PAYMENT_CALL_GAS + PAYMENT_CALL_GAS / 63 + BATCH_GAS_RESERVE) {
                revert InsufficientBatchGas(paymentId);
            }
            try this.executePaymentFromBatch{gas: PAYMENT_CALL_GAS}(paymentId, msg.sender) {
                ++completed;
            } catch (bytes memory reason) {
                // The subcall rolls back receiving, forwarding, nonce use and tip accounting together.
                emit PaymentFailed(paymentId, reason);
            }
        }
    }

    /// @dev External self-call creates the atomic rollback boundary for each batch item.
    /// The batch already holds the reentrancy lock; this worker must not acquire it again.
    function executePaymentFromBatch(uint256 paymentId, address executor) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _execute(paymentId, executor);
    }

    /// @notice Current owner (initially the deployer) withdraws all accrued tips to a recipient.
    /// @dev Sends six-decimal ERC-20 USDC, never mixes msg.value or native 18-decimal units.
    function withdrawTips(address recipient) external onlyOwner nonReentrant returns (uint256 amount) {
        if (recipient == address(0) || recipient == address(this) || recipient == address(usdc)) revert InvalidRecipient();
        amount = accruedTips;
        if (amount == 0) revert NoTips();
        accruedTips = 0;
        IERC20(address(usdc)).safeTransfer(recipient, amount);
        emit TipsWithdrawn(recipient, amount);
    }

    function getPayment(uint256 paymentId) external view returns (Payment memory) {
        return _payments[paymentId];
    }

    /// @dev EIP-3009 windows are exclusive: validAfter < timestamp < validBefore.
    /// Ready reflects local state/time; execution can still fail if funds are missing,
    /// USDC is paused, an address is blocklisted, or the authorization was revoked at USDC.
    function getPaymentState(uint256 paymentId) public view returns (PaymentState) {
        Payment storage payment = _payments[paymentId];
        if (payment.scheduleId == 0) return PaymentState.Unknown;
        if (payment.executed) return PaymentState.Executed;
        if (schedules[payment.scheduleId].cancelled) return PaymentState.Cancelled;
        if (block.timestamp >= payment.validBefore) return PaymentState.Expired;
        if (block.timestamp <= payment.validAfter) return PaymentState.Pending;
        return PaymentState.Ready;
    }

    /// @notice Bounded, read-only discovery for the cron job; no database required.
    /// Start with cursor=1. Scan <=100 records per call until nextCursor==nextPaymentId.
    function getDuePaymentIds(uint256 cursor, uint256 scanLimit) external view returns (uint256[] memory ids, uint256 nextCursor) {
        if (scanLimit == 0 || scanLimit > MAX_PAGE_SIZE) revert InvalidBatchSize();
        if (cursor == 0) cursor = 1;
        if (cursor >= nextPaymentId) return (new uint256[](0), nextPaymentId);
        uint256 count = nextPaymentId - cursor;
        if (count > scanLimit) count = scanLimit;
        nextCursor = cursor + count;
        ids = new uint256[](count);
        uint256 found;
        for (uint256 id = cursor; id < nextCursor; ++id) {
            if (getPaymentState(id) == PaymentState.Ready) ids[found++] = id;
        }
        // Only shrink a freshly allocated array; never reads or writes outside it.
        assembly ("memory-safe") { mstore(ids, found) }
    }

    function payerScheduleCount(address payer) external view returns (uint256) {
        return _payerSchedules[payer].length;
    }

    function getPayerScheduleIds(address payer, uint256 offset, uint256 limit) external view returns (uint256[] memory ids) {
        if (limit == 0 || limit > MAX_PAGE_SIZE) revert InvalidBatchSize();
        uint256[] storage allIds = _payerSchedules[payer];
        if (offset >= allIds.length) return new uint256[](0);
        uint256 count = allIds.length - offset;
        if (count > limit) count = limit;
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) ids[i] = allIds[offset + i];
    }

    function _execute(uint256 paymentId, address executor) private {
        PaymentState state = getPaymentState(paymentId);
        if (state != PaymentState.Ready) revert PaymentNotExecutable(paymentId, state);
        Payment storage payment = _payments[paymentId];
        address payer = schedules[payment.scheduleId].payer;
        payment.executed = true;
        _receiveAuthorizedPayment(payment, payer);
        IERC20(address(usdc)).safeTransfer(payment.payee, payment.amount);
        accruedTips += payment.tip;
        emit PaymentExecuted(paymentId, payment.scheduleId, payment.payee, payment.amount, payment.tip, executor);
    }

    function _receiveAuthorizedPayment(Payment storage payment, address payer) private {
        uint256 total = payment.amount + payment.tip;
        uint256 balanceBefore = usdc.balanceOf(address(this));
        // A no-return Solidity interface call can impose a code-length check. Use
        // a low-level call so system/precompile-backed interfaces remain supported.
        // Exact receipt verification prevents an empty-success fallback spending old tips.
        (bool success, bytes memory result) = address(usdc).call(abi.encodeCall(
            IUSDC.receiveWithAuthorization,
            (payer, address(this), total, payment.validAfter, payment.validBefore,
                payment.nonce, payment.v, payment.r, payment.s)
        ));
        if (!success) {
            assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        }
        if (usdc.balanceOf(address(this)) != balanceBefore + total) revert UnexpectedUSDCBalance();
    }
}
