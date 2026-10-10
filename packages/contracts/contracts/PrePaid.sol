// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUSDC} from "./interfaces/IUSDC.sol";

/// @notice Executes offchain instructions committed into EIP-3009 nonces.
/// @dev Only cancellations and platform tips are stored here. USDC owns replay protection.
contract PrePaid is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_BATCH_SIZE = 50;
    uint256 public constant RELAYER_TIP_PERCENT = 70;
    uint256 public constant PAYMENT_CALL_GAS = 300_000;
    uint256 private constant BATCH_GAS_RESERVE = 60_000;
    bytes32 public constant PAYMENT_NONCE_TYPEHASH = keccak256(
        "PrePaidPayment(uint256 chainId,address prepaid,address usdc,address payer,bytes32 scheduleId,address payee,uint256 amount,uint256 tip,uint256 validAfter,uint256 validBefore,bytes32 salt)"
    );

    IUSDC public immutable usdc;
    /// @notice Platform's 30% share only; unsolicited transfers are not earned tips.
    uint256 public accruedTips;
    /// @notice Random, nonzero schedule IDs are scoped to each payer.
    mapping(address => mapping(bytes32 => bool)) public cancelledSchedules;

    /// @dev Calldata only: signatures and routing data are never saved in storage.
    struct Payment {
        address payer;
        bytes32 scheduleId;
        address payee;
        uint256 amount;
        uint256 tip;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 salt;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    error InvalidUSDC();
    error InvalidPayment();
    error InvalidScheduleId();
    error ScheduleAlreadyCancelled();
    error ScheduleCancelled();
    error PaymentOutsideWindow();
    error InvalidBatchSize();
    error InsufficientBatchGas(uint256 index);
    error OnlySelf();
    error InvalidRecipient();
    error NoTips();
    error UnexpectedUSDCBalance();

    event ScheduleCancellation(address indexed payer, bytes32 indexed scheduleId);
    event PaymentExecuted(
        address indexed payer, bytes32 indexed scheduleId, bytes32 indexed nonce,
        address payee, uint256 amount, uint256 tip, address executor,
        uint256 relayerTip, uint256 platformTip
    );
    event PaymentFailed(uint256 indexed index, address indexed payer, bytes32 indexed scheduleId, bytes reason);
    event TipsWithdrawn(address indexed recipient, uint256 amount);

    constructor(address usdcAddress) Ownable(msg.sender) {
        if (usdcAddress == address(0)) revert InvalidUSDC();
        IUSDC token = IUSDC(usdcAddress);
        // Arc's system token must not be rejected for lacking ordinary bytecode.
        if (token.decimals() != 6 || token.DOMAIN_SEPARATOR() == bytes32(0)) revert InvalidUSDC();
        usdc = token;
    }

    /// @notice Read this nonce before signing USDC ReceiveWithAuthorization.
    /// @dev Changing any instruction changes the nonce and invalidates the USDC signature.
    /// Generate a fresh random salt for every occurrence, even for identical payments.
    function getPaymentNonce(Payment calldata payment) public view returns (bytes32) {
        return keccak256(abi.encode(
            PAYMENT_NONCE_TYPEHASH, block.chainid, address(this), address(usdc),
            payment.payer, payment.scheduleId, payment.payee, payment.amount,
            payment.tip, payment.validAfter, payment.validBefore, payment.salt
        ));
    }

    /// @notice Permanently cancels all remaining occurrences for the caller's schedule.
    /// No registration is necessary; cancellation can precede the first execution.
    function cancelSchedule(bytes32 scheduleId) external nonReentrant {
        if (scheduleId == bytes32(0)) revert InvalidScheduleId();
        if (cancelledSchedules[msg.sender][scheduleId]) revert ScheduleAlreadyCancelled();
        cancelledSchedules[msg.sender][scheduleId] = true;
        emit ScheduleCancellation(msg.sender, scheduleId);
    }

    function executePayment(Payment calldata payment) external nonReentrant {
        _execute(payment, msg.sender);
    }

    /// @notice Attempts each payment independently; inspect per-item receipt events.
    /// Failed items (including expired/cancelled/replayed ones) do not undo healthy items.
    function executePayments(Payment[] calldata payments) external nonReentrant returns (uint256 completed) {
        uint256 count = payments.length;
        if (count == 0 || count > MAX_BATCH_SIZE) revert InvalidBatchSize();
        for (uint256 i; i < count; ++i) {
            // Prevent gas estimation from choosing a limit that silently does no work.
            if (gasleft() < PAYMENT_CALL_GAS + PAYMENT_CALL_GAS / 63 + BATCH_GAS_RESERVE) {
                revert InsufficientBatchGas(i);
            }
            try this.executePaymentFromBatch{gas: PAYMENT_CALL_GAS}(payments[i], msg.sender) {
                ++completed;
            } catch (bytes memory reason) {
                emit PaymentFailed(i, payments[i].payer, payments[i].scheduleId, reason);
            }
        }
    }

    /// @dev Self-call provides rollback isolation. The outer batch holds the reentrancy lock.
    function executePaymentFromBatch(Payment calldata payment, address executor) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _execute(payment, executor);
    }

    function withdrawTips(address recipient) external onlyOwner nonReentrant returns (uint256 amount) {
        if (recipient == address(0) || recipient == address(this) || recipient == address(usdc)) revert InvalidRecipient();
        amount = accruedTips;
        if (amount == 0) revert NoTips();
        accruedTips = 0;
        IERC20(address(usdc)).safeTransfer(recipient, amount);
        emit TipsWithdrawn(recipient, amount);
    }

    function _execute(Payment calldata payment, address executor) private {
        if (payment.payer == address(0) || payment.scheduleId == bytes32(0)
            || payment.payee == address(0) || payment.payee == address(this)
            || payment.payee == address(usdc) || payment.amount == 0
            || payment.validAfter >= payment.validBefore) revert InvalidPayment();
        if (cancelledSchedules[payment.payer][payment.scheduleId]) revert ScheduleCancelled();
        if (block.timestamp <= payment.validAfter || block.timestamp >= payment.validBefore) revert PaymentOutsideWindow();
        bytes32 nonce = getPaymentNonce(payment);
        _receiveAuthorizedPayment(payment, nonce);

        uint256 relayerTip = Math.mulDiv(payment.tip, RELAYER_TIP_PERCENT, 100);
        uint256 platformTip = payment.tip - relayerTip;
        accruedTips += platformTip;
        IERC20 token = IERC20(address(usdc));
        token.safeTransfer(payment.payee, payment.amount);
        if (relayerTip != 0) token.safeTransfer(executor, relayerTip);
        emit PaymentExecuted(payment.payer, payment.scheduleId, nonce, payment.payee,
            payment.amount, payment.tip, executor, relayerTip, platformTip);
    }

    function _receiveAuthorizedPayment(Payment calldata payment, bytes32 nonce) private {
        uint256 total = payment.amount + payment.tip;
        uint256 balanceBefore = usdc.balanceOf(address(this));
        // Low-level no-return call supports Arc's system token. Exact receipt verification
        // prevents an empty-success fallback spending previously collected tips.
        (bool success, bytes memory result) = address(usdc).call(abi.encodeCall(
            IUSDC.receiveWithAuthorization,
            (payment.payer, address(this), total, payment.validAfter, payment.validBefore,
                nonce, payment.v, payment.r, payment.s)
        ));
        if (!success) {
            assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        }
        if (usdc.balanceOf(address(this)) != balanceBefore + total) revert UnexpectedUSDCBalance();
    }
}
