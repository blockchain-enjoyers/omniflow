// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClaimEscrow} from "../src/ClaimEscrow.sol";
import {MockUSDC} from "./mocks/MockTokens.sol";

/// Drives the escrow with random sequences of deposits, claims (valid and forged), refunds, expiries,
/// rekeys, time jumps and stray donations, while keeping ghost books of where money should be.
contract EscrowHandler is Test {
    ClaimEscrow public escrow;
    MockUSDC public usdc;

    address[3] public depositors = [makeAddr("dep0"), makeAddr("dep1"), makeAddr("dep2")];
    address public attacker = makeAddr("attacker");
    address[3] public recipients = [makeAddr("rcp0"), makeAddr("rcp1"), makeAddr("rcp2")];
    address public relayer = makeAddr("relayer");

    bytes32[] public ids;
    mapping(bytes32 => uint256) public keyOf;
    mapping(bytes32 => uint256) public terminalTransitions;
    mapping(bytes32 => ClaimEscrow.Status) public lastSeenStatus;

    uint256 public ghostPending; // Σ amount+tip of Pending deposits
    uint256 public ghostDonated; // tokens sent to the escrow outside deposit()
    uint256 public ghostPaidToRecipients;
    uint256 public ghostTipsToRelayer;
    uint256 public ghostTipsToAttacker;
    mapping(address => uint256) public ghostRefundedTo;
    mapping(address => uint256) public ghostDepositedBy;
    uint256 public forgedSuccesses; // must stay 0

    uint256 nonce;

    constructor(ClaimEscrow escrow_, MockUSDC usdc_) {
        escrow = escrow_;
        usdc = usdc_;
        for (uint256 i; i < 3; ++i) {
            usdc.mint(depositors[i], 1e30);
            vm.prank(depositors[i]);
            usdc.approve(address(escrow), type(uint256).max);
        }
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function _pick(uint256 seed) internal view returns (bytes32 id, bool ok) {
        if (ids.length == 0) return (bytes32(0), false);
        return (ids[seed % ids.length], true);
    }

    function _sign(uint256 pk, bytes32 id, address to, uint256 deadline) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, escrow.claimDigest(id, to, deadline));
        return abi.encodePacked(r, s, v);
    }

    function _recordStatus(bytes32 id) internal {
        lastSeenStatus[id] = escrow.getDeposit(id).status;
    }

    // ---------------------------------------------------------------- actions

    function deposit(uint256 depSeed, uint96 amount, uint96 tip, uint40 refundIn, bool withExpiry) external {
        address dep = depositors[depSeed % 3];
        amount = uint96(bound(amount, 1, 1_000_000e6));
        tip = uint96(bound(tip, 0, 10e6));
        uint40 at = withExpiry ? uint40(block.timestamp + bound(refundIn, 1, 400 days)) : 0;
        bytes32 id = keccak256(abi.encode(dep, nonce++));
        uint256 pk = uint256(keccak256(abi.encode("key", id))) % 1e70 + 1;

        vm.prank(dep);
        escrow.deposit(id, address(usdc), amount, tip, vm.addr(pk), at);
        ids.push(id);
        keyOf[id] = pk;
        ghostPending += uint256(amount) + tip;
        ghostDepositedBy[dep] += uint256(amount) + tip;
        _recordStatus(id);
    }

    /// A real claim with the key from the link, submitted by the relayer or by the attacker (both legal).
    function claim(uint256 idSeed, uint256 rcpSeed, bool attackerSubmits) external {
        (bytes32 id, bool ok) = _pick(idSeed);
        if (!ok) return;
        ClaimEscrow.Deposit memory d = escrow.getDeposit(id);
        address to = recipients[rcpSeed % 3];
        bytes memory sig = _sign(keyOf[id], id, to, block.timestamp);
        address submitter = attackerSubmits ? attacker : relayer;

        vm.prank(submitter);
        try escrow.claim(id, to, block.timestamp, sig) {
            terminalTransitions[id]++;
            ghostPending -= uint256(d.amount) + d.tip;
            ghostPaidToRecipients += d.amount;
            if (attackerSubmits) ghostTipsToAttacker += d.tip;
            else ghostTipsToRelayer += d.tip;
        } catch {}
        _recordStatus(id);
    }

    /// The attacker tries to redirect funds to himself with signatures he can make.
    function forgeClaim(uint256 idSeed, uint256 wrongPk, uint8 mode) external {
        (bytes32 id, bool ok) = _pick(idSeed);
        if (!ok) return;
        wrongPk = bound(wrongPk, 1, 1e70);
        if (wrongPk == keyOf[id]) wrongPk++;
        bytes memory sig;
        uint256 m = mode % 3;
        if (m == 0) {
            // own key
            sig = _sign(wrongPk, id, attacker, block.timestamp);
        } else if (m == 1) {
            // intercepted valid signature for a recipient, replayed to himself
            sig = _sign(keyOf[id], id, recipients[0], block.timestamp);
        } else {
            // valid key, but for another deposit id
            sig = _sign(keyOf[id], keccak256(abi.encode(id, "other")), attacker, block.timestamp);
        }
        vm.prank(attacker);
        try escrow.claim(id, attacker, block.timestamp, sig) {
            forgedSuccesses++;
        } catch {}
        _recordStatus(id);
    }

    function refund(uint256 idSeed, bool asDepositor) external {
        (bytes32 id, bool ok) = _pick(idSeed);
        if (!ok) return;
        ClaimEscrow.Deposit memory d = escrow.getDeposit(id);
        address caller = asDepositor ? d.depositor : attacker;
        vm.prank(caller);
        try escrow.refund(id) {
            if (!asDepositor) forgedSuccesses++;
            terminalTransitions[id]++;
            ghostPending -= uint256(d.amount) + d.tip;
            ghostRefundedTo[d.depositor] += uint256(d.amount) + d.tip;
        } catch {}
        _recordStatus(id);
    }

    function refundExpired(uint256 idSeed) external {
        (bytes32 id, bool ok) = _pick(idSeed);
        if (!ok) return;
        ClaimEscrow.Deposit memory d = escrow.getDeposit(id);
        vm.prank(attacker);
        try escrow.refundExpired(id) {
            if (d.autoRefundAt == 0) forgedSuccesses++; // no expiry when autoRefundAt is zero
            terminalTransitions[id]++;
            ghostPending -= uint256(d.amount) + d.tip;
            ghostRefundedTo[d.depositor] += uint256(d.amount) + d.tip;
        } catch {}
        _recordStatus(id);
    }

    function rekey(uint256 idSeed, bool asDepositor, uint256 newPk) external {
        (bytes32 id, bool ok) = _pick(idSeed);
        if (!ok) return;
        newPk = bound(newPk, 1, 1e70);
        address caller = asDepositor ? escrow.getDeposit(id).depositor : attacker;
        vm.prank(caller);
        try escrow.rekey(id, vm.addr(newPk)) {
            if (!asDepositor) forgedSuccesses++;
            keyOf[id] = newPk;
        } catch {}
    }

    function setAutoRefund(uint256 idSeed, bool asDepositor, uint40 inSecs, bool clear) external {
        (bytes32 id, bool ok) = _pick(idSeed);
        if (!ok) return;
        uint40 at = clear ? 0 : uint40(block.timestamp + bound(inSecs, 1, 400 days));
        address caller = asDepositor ? escrow.getDeposit(id).depositor : attacker;
        vm.prank(caller);
        try escrow.setAutoRefund(id, at) {
            if (!asDepositor) forgedSuccesses++;
        } catch {}
    }

    function donate(uint96 amount) external {
        amount = uint96(bound(amount, 1, 1_000e6));
        usdc.mint(address(escrow), amount);
        ghostDonated += amount;
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 60 days));
    }
}

contract ClaimEscrowInvariantTest is Test {
    ClaimEscrow escrow;
    MockUSDC usdc;
    EscrowHandler handler;

    function setUp() public {
        usdc = new MockUSDC();
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        escrow = new ClaimEscrow(tokens);
        handler = new EscrowHandler(escrow, usdc);
        targetContract(address(handler));
    }

    /// the escrow always holds at least what it owes; exactly that plus stray donations.
    function invariant_solvency() public view {
        assertEq(usdc.balanceOf(address(escrow)), handler.ghostPending() + handler.ghostDonated());
    }

    /// Solvency cross-check: recompute the pending sum from contract state, not from ghosts.
    function invariant_pendingSumMatchesState() public view {
        uint256 sum;
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            ClaimEscrow.Deposit memory d = escrow.getDeposit(handler.ids(i));
            if (d.status == ClaimEscrow.Status.Pending) sum += uint256(d.amount) + d.tip;
        }
        assertEq(sum, handler.ghostPending());
    }

    /// every deposit reaches a terminal status at most once and never leaves it.
    function invariant_terminalOnce() public view {
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.ids(i);
            assertLe(handler.terminalTransitions(id), 1);
            ClaimEscrow.Status s = escrow.getDeposit(id).status;
            assertTrue(s != ClaimEscrow.Status.None);
            if (handler.terminalTransitions(id) == 1) assertTrue(s != ClaimEscrow.Status.Pending);
            else assertEq(uint8(s), uint8(ClaimEscrow.Status.Pending));
        }
    }

    /// no forged claim, foreign refund/rekey/setAutoRefund, or expiry of a
    /// never-expiring deposit ever succeeded.
    function invariant_noForgedSuccess() public view {
        assertEq(handler.forgedSuccesses(), 0);
    }

    /// the attacker only ever received tips for claims he legitimately relayed.
    function invariant_attackerOnlyLegitTips() public view {
        assertEq(usdc.balanceOf(handler.attacker()), handler.ghostTipsToAttacker());
    }

    /// every token that left the escrow went to a recipient, a submitter or a depositor.
    function invariant_outflowsAccounted() public view {
        uint256 toRecipients;
        for (uint256 i; i < 3; ++i) {
            toRecipients += usdc.balanceOf(handler.recipients(i));
        }
        assertEq(toRecipients, handler.ghostPaidToRecipients());
        assertEq(usdc.balanceOf(handler.relayer()), handler.ghostTipsToRelayer());
        for (uint256 i; i < 3; ++i) {
            address dep = handler.depositors(i);
            // started at 1e30; changed only by own deposits out and own refunds back
            assertEq(usdc.balanceOf(dep), 1e30 - handler.ghostDepositedBy(dep) + handler.ghostRefundedTo(dep));
        }
    }
}
