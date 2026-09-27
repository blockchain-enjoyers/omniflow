// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "solady/utils/ECDSA.sol";
import {EIP712} from "solady/utils/EIP712.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";

/// @title ClaimEscrow
/// @notice Holds a payment for a recipient without a wallet until they claim it with the key
///         from their link, or the depositor takes it back.
/// @dev Deliberately has no owner, pause, upgrade, sweep or rescue. Funds leave only to:
///      the recipient named in a claim signature, the claim submitter (tip only), or the depositor.
///      The token allowlist is fixed at construction.
contract ClaimEscrow is EIP712, ReentrancyGuard {
    enum Status {
        None,
        Pending,
        Claimed,
        Refunded
    }

    struct Deposit {
        address depositor;
        uint96 amount;
        address token;
        uint96 tip;
        address claimSigner;
        uint40 autoRefundAt;
        Status status;
    }

    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(bytes32 id,address recipient,uint256 deadline)");

    mapping(bytes32 id => Deposit) internal _deposits;
    mapping(address token => bool) public isAllowedToken;

    event Deposited(
        bytes32 indexed id,
        address indexed depositor,
        address indexed token,
        uint96 amount,
        uint96 tip,
        address claimSigner,
        uint40 autoRefundAt
    );
    event Claimed(bytes32 indexed id, address indexed recipient, address relayer);
    event Refunded(bytes32 indexed id, bool byExpiry);
    event Rekeyed(bytes32 indexed id, address newClaimSigner);
    event AutoRefundSet(bytes32 indexed id, uint40 autoRefundAt);

    error TokenNotAllowed();
    error DepositExists();
    error ZeroAmount();
    error ZeroAddress();
    error InvalidAutoRefund();
    error BalanceDeltaMismatch();
    error NotPending();
    error NotDepositor();
    error Expired();
    error InvalidSignature();
    error NotRefundable();

    constructor(address[] memory tokens) {
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i] == address(0)) revert ZeroAddress();
            isAllowedToken[tokens[i]] = true;
        }
    }

    // ---------------------------------------------------------------- deposit

    /// @notice Locks `amount + tip` of `token` from msg.sender. msg.sender becomes the only refund address.
    function deposit(
        bytes32 id,
        address token,
        uint96 amount,
        uint96 tip,
        address claimSigner,
        uint40 autoRefundAt
    ) external nonReentrant {
        if (!isAllowedToken[token]) revert TokenNotAllowed();
        if (_deposits[id].status != Status.None) revert DepositExists();
        if (amount == 0) revert ZeroAmount();
        if (claimSigner == address(0)) revert ZeroAddress();
        if (autoRefundAt != 0 && autoRefundAt <= block.timestamp) revert InvalidAutoRefund();

        _deposits[id] = Deposit({
            depositor: msg.sender,
            amount: amount,
            token: token,
            tip: tip,
            claimSigner: claimSigner,
            autoRefundAt: autoRefundAt,
            status: Status.Pending
        });

        uint256 total = uint256(amount) + tip;
        uint256 before = SafeTransferLib.balanceOf(token, address(this));
        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), total);
        if (SafeTransferLib.balanceOf(token, address(this)) - before != total) revert BalanceDeltaMismatch();

        emit Deposited(id, msg.sender, token, amount, tip, claimSigner, autoRefundAt);
    }

    // ------------------------------------------------------------------ claim

    /// @notice Sends `amount` to `recipient` if `signature` is by the deposit's claim key. Anyone may submit;
    ///         the submitter receives the tip.
    function claim(bytes32 id, address recipient, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        Deposit storage d = _deposits[id];
        if (d.status != Status.Pending) revert NotPending();
        if (block.timestamp > deadline) revert Expired();
        if (recipient == address(0)) revert ZeroAddress();

        address signer = ECDSA.tryRecoverCalldata(claimDigest(id, recipient, deadline), signature);
        if (signer == address(0) || signer != d.claimSigner) revert InvalidSignature();

        d.status = Status.Claimed;
        address token = d.token;
        uint96 tip = d.tip;
        SafeTransferLib.safeTransfer(token, recipient, d.amount);
        if (tip != 0) SafeTransferLib.safeTransfer(token, msg.sender, tip);

        emit Claimed(id, recipient, msg.sender);
    }

    // ----------------------------------------------------------------- refund

    /// @notice Depositor takes back an unclaimed deposit. Races with claim; first to land wins.
    function refund(bytes32 id) external nonReentrant {
        Deposit storage d = _deposits[id];
        if (d.status != Status.Pending) revert NotPending();
        if (msg.sender != d.depositor) revert NotDepositor();
        _refund(id, d, false);
    }

    /// @notice Anyone may return an expired deposit — to the depositor only.
    function refundExpired(bytes32 id) external nonReentrant {
        Deposit storage d = _deposits[id];
        if (d.status != Status.Pending) revert NotPending();
        if (d.autoRefundAt == 0 || block.timestamp < d.autoRefundAt) revert NotRefundable();
        _refund(id, d, true);
    }

    function _refund(bytes32 id, Deposit storage d, bool byExpiry) private {
        d.status = Status.Refunded;
        SafeTransferLib.safeTransfer(d.token, d.depositor, uint256(d.amount) + d.tip);
        emit Refunded(id, byExpiry);
    }

    // ------------------------------------------------------ depositor controls

    /// @notice Replaces the claim key; the old link stops working.
    function rekey(bytes32 id, address newClaimSigner) external {
        Deposit storage d = _deposits[id];
        if (d.status != Status.Pending) revert NotPending();
        if (msg.sender != d.depositor) revert NotDepositor();
        if (newClaimSigner == address(0)) revert ZeroAddress();
        d.claimSigner = newClaimSigner;
        emit Rekeyed(id, newClaimSigner);
    }

    /// @notice Sets or clears (0) the auto-refund time.
    function setAutoRefund(bytes32 id, uint40 at) external {
        Deposit storage d = _deposits[id];
        if (d.status != Status.Pending) revert NotPending();
        if (msg.sender != d.depositor) revert NotDepositor();
        if (at != 0 && at <= block.timestamp) revert InvalidAutoRefund();
        d.autoRefundAt = at;
        emit AutoRefundSet(id, at);
    }

    // ------------------------------------------------------------------- views

    function getDeposit(bytes32 id) external view returns (Deposit memory) {
        return _deposits[id];
    }

    function claimDigest(bytes32 id, address recipient, uint256 deadline) public view returns (bytes32) {
        return _hashTypedData(keccak256(abi.encode(CLAIM_TYPEHASH, id, recipient, deadline)));
    }

    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("OmniflowClaimEscrow", "1");
    }
}
