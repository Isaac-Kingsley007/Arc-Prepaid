// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IUSDC} from "../interfaces/IUSDC.sol";

/// @dev Test-only standard ERC-20/EIP-3009 mock. Does not reproduce Arc's native balance model.
contract MockUSDC is ERC20, EIP712, IUSDC {
    bytes32 private constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    mapping(address => mapping(bytes32 => bool)) public override authorizationState;
    mapping(address => bool) public blocked;
    bool public paused;
    bool public failTransfers;
    bool public noReceive;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackSucceeded;

    constructor() ERC20("USDC", "USDC") EIP712("USDC", "2") {}

    function decimals() public pure override(ERC20, IERC20Metadata) returns (uint8) { return 6; }
    function DOMAIN_SEPARATOR() external view returns (bytes32) { return _domainSeparatorV4(); }
    function mint(address to, uint256 value) external { _mint(to, value); }
    function setBlocked(address account, bool value) external { blocked[account] = value; }
    function setPaused(bool value) external { paused = value; }
    function setFailTransfers(bool value) external { failTransfers = value; }
    function setNoReceive(bool value) external { noReceive = value; }
    function setCallback(address target, bytes calldata data) external { callbackTarget = target; callbackData = data; }
    function cancelAuthorization(bytes32 nonce) external { authorizationState[msg.sender][nonce] = true; }

    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore,
        bytes32 nonce, uint8 v, bytes32 r, bytes32 s
    ) external {
        if (noReceive) return;
        require(!paused, "USDC paused");
        require(to == msg.sender, "FiatTokenV2: caller must be the payee");
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!authorizationState[from][nonce], "FiatTokenV2: authorization is used or canceled");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            RECEIVE_TYPEHASH, from, to, value, validAfter, validBefore, nonce
        )));
        require(SignatureChecker.isValidSignatureNow(from, digest, abi.encodePacked(r, s, v)), "Invalid signature");
        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }

    function transfer(address to, uint256 value) public override(ERC20, IERC20) returns (bool) {
        if (failTransfers) return false;
        if (callbackTarget != address(0)) {
            (callbackSucceeded,) = callbackTarget.call(callbackData);
        }
        return super.transfer(to, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "USDC blocklisted");
        super._update(from, to, value);
    }
}
