// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClaimEscrow} from "../src/ClaimEscrow.sol";
import {MockUSDC, FeeOnTransferToken} from "./mocks/MockTokens.sol";

/// Unit and fuzz tests.
contract ClaimEscrowTest is Test {
    ClaimEscrow escrow;
    MockUSDC usdc;
    FeeOnTransferToken feeToken;

    address depositor = makeAddr("orgAccount");
    address recipient = makeAddr("recipient");
    address relayer = makeAddr("relayer");
    address stranger = makeAddr("stranger");

    uint256 claimPk = 0xC1A1;
    address claimSigner;

    bytes32 constant ID = keccak256("payout-1/row-1");
    uint96 constant AMOUNT = 1_000e6;
    uint96 constant TIP = 1e6;

    function setUp() public {
        usdc = new MockUSDC();
        feeToken = new FeeOnTransferToken();
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(feeToken);
        escrow = new ClaimEscrow(tokens);

        claimSigner = vm.addr(claimPk);
        usdc.mint(depositor, 1_000_000e6);
        vm.prank(depositor);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ------------------------------------------------------------ helpers

    function _deposit(bytes32 id, uint40 autoRefundAt) internal {
        vm.prank(depositor);
        escrow.deposit(id, address(usdc), AMOUNT, TIP, claimSigner, autoRefundAt);
    }

    function _sign(uint256 pk, bytes32 id, address to, uint256 deadline) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, escrow.claimDigest(id, to, deadline));
        return abi.encodePacked(r, s, v);
    }

    function _status(bytes32 id) internal view returns (ClaimEscrow.Status) {
        return escrow.getDeposit(id).status;
    }

    // ------------------------------------------------------------ deposit

    function test_deposit_recordsAndPulls() public {
        vm.expectEmit(address(escrow));
        emit ClaimEscrow.Deposited(ID, depositor, address(usdc), AMOUNT, TIP, claimSigner, 0);
        _deposit(ID, 0);

        ClaimEscrow.Deposit memory d = escrow.getDeposit(ID);
        assertEq(d.depositor, depositor);
        assertEq(d.amount, AMOUNT);
        assertEq(d.tip, TIP);
        assertEq(d.claimSigner, claimSigner);
        assertEq(uint8(d.status), uint8(ClaimEscrow.Status.Pending));
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT + TIP);
    }

    /// the same id cannot be deposited twice.
    function test_duplicateIdReverts() public {
        _deposit(ID, 0);
        vm.prank(depositor);
        vm.expectRevert(ClaimEscrow.DepositExists.selector);
        escrow.deposit(ID, address(usdc), AMOUNT, TIP, claimSigner, 0);
    }

    /// Also after the deposit is finished: ids are never reused.
    function test_idNotReusableAfterRefund() public {
        _deposit(ID, 0);
        vm.prank(depositor);
        escrow.refund(ID);
        vm.prank(depositor);
        vm.expectRevert(ClaimEscrow.DepositExists.selector);
        escrow.deposit(ID, address(usdc), AMOUNT, TIP, claimSigner, 0);
    }

    function test_deposit_rejectsBadInput() public {
        vm.startPrank(depositor);
        vm.expectRevert(ClaimEscrow.TokenNotAllowed.selector);
        escrow.deposit(ID, address(0xdead), AMOUNT, TIP, claimSigner, 0);
        vm.expectRevert(ClaimEscrow.ZeroAmount.selector);
        escrow.deposit(ID, address(usdc), 0, TIP, claimSigner, 0);
        vm.expectRevert(ClaimEscrow.ZeroAddress.selector);
        escrow.deposit(ID, address(usdc), AMOUNT, TIP, address(0), 0);
        vm.expectRevert(ClaimEscrow.InvalidAutoRefund.selector);
        escrow.deposit(ID, address(usdc), AMOUNT, TIP, claimSigner, uint40(block.timestamp));
        vm.stopPrank();
    }

    /// a token that delivers less than asked is rejected, so recorded == held.
    function test_feeOnTransferRejected() public {
        feeToken.mint(depositor, 10_000e6);
        vm.startPrank(depositor);
        feeToken.approve(address(escrow), type(uint256).max);
        vm.expectRevert(ClaimEscrow.BalanceDeltaMismatch.selector);
        escrow.deposit(ID, address(feeToken), AMOUNT, TIP, claimSigner, 0);
        vm.stopPrank();
    }

    function test_constructor_rejectsZeroToken() public {
        address[] memory tokens = new address[](1);
        vm.expectRevert(ClaimEscrow.ZeroAddress.selector);
        new ClaimEscrow(tokens);
    }

    // -------------------------------------------------------------- claim

    /// recipient gets exactly `amount`; the tip goes to whoever submitted.
    function test_claimPaysFullAmountAndTipToSubmitter() public {
        _deposit(ID, 0);
        bytes memory sig = _sign(claimPk, ID, recipient, block.timestamp + 1 days);

        vm.expectEmit(address(escrow));
        emit ClaimEscrow.Claimed(ID, recipient, relayer);
        vm.prank(relayer);
        escrow.claim(ID, recipient, block.timestamp + 1 days, sig);

        assertEq(usdc.balanceOf(recipient), AMOUNT);
        assertEq(usdc.balanceOf(relayer), TIP);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(_status(ID)), uint8(ClaimEscrow.Status.Claimed));
    }

    function testFuzz_recipientGetsExactAmount(uint96 amount, uint96 tip, address to) public {
        vm.assume(to != address(0) && to != address(escrow) && to != relayer && to != depositor);
        amount = uint96(bound(amount, 1, 100_000e6));
        tip = uint96(bound(tip, 0, 10e6));
        vm.prank(depositor);
        escrow.deposit(ID, address(usdc), amount, tip, claimSigner, 0);

        uint256 before = usdc.balanceOf(to);
        bytes memory sig = _sign(claimPk, ID, to, block.timestamp);
        vm.prank(relayer);
        escrow.claim(ID, to, block.timestamp, sig);
        assertEq(usdc.balanceOf(to) - before, amount);
    }

    /// a link gives exactly one claim.
    function test_secondClaimReverts() public {
        _deposit(ID, 0);
        bytes memory sig = _sign(claimPk, ID, recipient, block.timestamp);
        escrow.claim(ID, recipient, block.timestamp, sig);
        vm.expectRevert(ClaimEscrow.NotPending.selector);
        escrow.claim(ID, recipient, block.timestamp, sig);
    }

    /// a malleated (high-s) copy of a used signature is still stopped by the status.
    function test_malleatedSignatureCannotClaimAgain() public {
        _deposit(ID, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(claimPk, escrow.claimDigest(ID, recipient, block.timestamp));
        escrow.claim(ID, recipient, block.timestamp, abi.encodePacked(r, s, v));

        bytes32 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory malleated = abi.encodePacked(r, bytes32(uint256(n) - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(ClaimEscrow.NotPending.selector);
        escrow.claim(ID, recipient, block.timestamp, malleated);
    }

    /// a signature is bound to the recipient — a mempool observer cannot redirect it.
    function testFuzz_signatureBoundToRecipient(address other) public {
        vm.assume(other != recipient && other != address(0));
        _deposit(ID, 0);
        bytes memory sig = _sign(claimPk, ID, recipient, block.timestamp);
        vm.expectRevert(ClaimEscrow.InvalidSignature.selector);
        escrow.claim(ID, other, block.timestamp, sig);
    }

    /// bound to the deposit id.
    function test_signatureBoundToId() public {
        bytes32 id2 = keccak256("payout-1/row-2");
        _deposit(ID, 0);
        _deposit(id2, 0);
        bytes memory sig = _sign(claimPk, ID, recipient, block.timestamp);
        vm.expectRevert(ClaimEscrow.InvalidSignature.selector);
        escrow.claim(id2, recipient, block.timestamp, sig);
    }

    /// bound to the deadline.
    function test_signatureBoundToDeadline() public {
        _deposit(ID, 0);
        bytes memory sig = _sign(claimPk, ID, recipient, block.timestamp);
        vm.expectRevert(ClaimEscrow.InvalidSignature.selector);
        escrow.claim(ID, recipient, block.timestamp + 1, sig);
    }

    /// bound to the chain.
    function test_signatureBoundToChain() public {
        _deposit(ID, 0);
        bytes memory sig = _sign(claimPk, ID, recipient, block.timestamp);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(ClaimEscrow.InvalidSignature.selector);
        escrow.claim(ID, recipient, block.timestamp, sig);
    }

    /// bound to this escrow instance.
    function test_signatureBoundToContract() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        ClaimEscrow other = new ClaimEscrow(tokens);
        vm.prank(depositor);
        usdc.approve(address(other), type(uint256).max);
        vm.prank(depositor);
        other.deposit(ID, address(usdc), AMOUNT, TIP, claimSigner, 0);
        _deposit(ID, 0);

        bytes memory sigForThis = _sign(claimPk, ID, recipient, block.timestamp);
        vm.expectRevert(ClaimEscrow.InvalidSignature.selector);
        other.claim(ID, recipient, block.timestamp, sigForThis);
    }

    function testFuzz_wrongKeyRejected(uint256 pk) public {
        pk = bound(pk, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        vm.assume(pk != claimPk);
        _deposit(ID, 0);
        bytes memory sig = _sign(pk, ID, recipient, block.timestamp);
        vm.expectRevert(ClaimEscrow.InvalidSignature.selector);
        escrow.claim(ID, recipient, block.timestamp, sig);
    }

    function test_claim_garbageSignatureRejected() public {
        _deposit(ID, 0);
        vm.expectRevert(ClaimEscrow.InvalidSignature.selector);
        escrow.claim(ID, recipient, block.timestamp, hex"1234");
    }

    function test_claim_pastDeadlineReverts() public {
        _deposit(ID, 0);
        uint256 deadline = block.timestamp;
        bytes memory sig = _sign(claimPk, ID, recipient, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(ClaimEscrow.Expired.selector);
        escrow.claim(ID, recipient, deadline, sig);
    }

    function test_claim_zeroRecipientReverts() public {
        _deposit(ID, 0);
        bytes memory sig = _sign(claimPk, ID, address(0), block.timestamp);
        vm.expectRevert(ClaimEscrow.ZeroAddress.selector);
        escrow.claim(ID, address(0), block.timestamp, sig);
    }

    /// a blocklisted recipient can claim to another address with a fresh signature.
    function test_claim_blockedRecipientCanUseAnotherAddress() public {
        _deposit(ID, 0);
        usdc.setBlocked(recipient, true);
        bytes memory sig = _sign(claimPk, ID, recipient, block.timestamp);
        vm.expectRevert();
        escrow.claim(ID, recipient, block.timestamp, sig);
        assertEq(uint8(_status(ID)), uint8(ClaimEscrow.Status.Pending));

        address second = makeAddr("recipient-2");
        escrow.claim(ID, second, block.timestamp, _sign(claimPk, ID, second, block.timestamp));
        assertEq(usdc.balanceOf(second), AMOUNT);
    }

    function test_claim_zeroTipSkipsTipTransfer() public {
        vm.prank(depositor);
        escrow.deposit(ID, address(usdc), AMOUNT, 0, claimSigner, 0);
        vm.prank(relayer);
        escrow.claim(ID, recipient, block.timestamp, _sign(claimPk, ID, recipient, block.timestamp));
        assertEq(usdc.balanceOf(relayer), 0);
        assertEq(usdc.balanceOf(recipient), AMOUNT);
    }

    // ------------------------------------------------------------- refund

    function test_refund_returnsAmountAndTip() public {
        _deposit(ID, 0);
        uint256 before = usdc.balanceOf(depositor);
        vm.expectEmit(address(escrow));
        emit ClaimEscrow.Refunded(ID, false);
        vm.prank(depositor);
        escrow.refund(ID);
        assertEq(usdc.balanceOf(depositor) - before, AMOUNT + TIP);
        assertEq(uint8(_status(ID)), uint8(ClaimEscrow.Status.Refunded));
    }

    /// only the depositor can refund, rekey or change the auto-refund time.
    function testFuzz_onlyDepositorControls(address caller) public {
        vm.assume(caller != depositor);
        _deposit(ID, 0);
        vm.startPrank(caller);
        vm.expectRevert(ClaimEscrow.NotDepositor.selector);
        escrow.refund(ID);
        vm.expectRevert(ClaimEscrow.NotDepositor.selector);
        escrow.rekey(ID, caller);
        vm.expectRevert(ClaimEscrow.NotDepositor.selector);
        escrow.setAutoRefund(ID, uint40(block.timestamp + 1));
        vm.stopPrank();
    }

    /// claim first → refund fails.
    function test_claimThenRefundFails() public {
        _deposit(ID, 0);
        escrow.claim(ID, recipient, block.timestamp, _sign(claimPk, ID, recipient, block.timestamp));
        vm.prank(depositor);
        vm.expectRevert(ClaimEscrow.NotPending.selector);
        escrow.refund(ID);
    }

    /// refund first → claim fails.
    function test_refundThenClaimFails() public {
        _deposit(ID, 0);
        bytes memory sig = _sign(claimPk, ID, recipient, block.timestamp);
        vm.prank(depositor);
        escrow.refund(ID);
        vm.expectRevert(ClaimEscrow.NotPending.selector);
        escrow.claim(ID, recipient, block.timestamp, sig);
    }

    // ------------------------------------------------------ refundExpired

    /// with autoRefundAt = 0 the deposit never expires.
    function testFuzz_noExpiryWhenZero(uint256 warpBy) public {
        _deposit(ID, 0);
        vm.warp(block.timestamp + bound(warpBy, 0, 100 * 365 days));
        vm.prank(stranger);
        vm.expectRevert(ClaimEscrow.NotRefundable.selector);
        escrow.refundExpired(ID);
    }

    function test_refundExpired_notBeforeTime() public {
        uint40 at = uint40(block.timestamp + 30 days);
        _deposit(ID, at);
        vm.warp(at - 1);
        vm.expectRevert(ClaimEscrow.NotRefundable.selector);
        escrow.refundExpired(ID);
    }

    /// Anyone may trigger it; the money goes to the depositor only.
    function test_refundExpired_anyoneTriggersDepositorReceives() public {
        uint40 at = uint40(block.timestamp + 30 days);
        _deposit(ID, at);
        vm.warp(at);
        uint256 before = usdc.balanceOf(depositor);
        vm.expectEmit(address(escrow));
        emit ClaimEscrow.Refunded(ID, true);
        vm.prank(stranger);
        escrow.refundExpired(ID);
        assertEq(usdc.balanceOf(depositor) - before, AMOUNT + TIP);
        assertEq(usdc.balanceOf(stranger), 0);
    }

    /// Before expiry is executed, a claim still wins.
    function test_refundExpired_claimStillPossibleUntilExecuted() public {
        uint40 at = uint40(block.timestamp + 1 days);
        _deposit(ID, at);
        vm.warp(at + 10);
        escrow.claim(ID, recipient, block.timestamp, _sign(claimPk, ID, recipient, block.timestamp));
        vm.expectRevert(ClaimEscrow.NotPending.selector);
        escrow.refundExpired(ID);
    }

    // ---------------------------------------------------- depositor controls

    /// rekey kills the old link and enables the new one.
    function test_rekey_oldLinkDiesNewWorks() public {
        _deposit(ID, 0);
        uint256 newPk = 0xBEEF;
        vm.expectEmit(address(escrow));
        emit ClaimEscrow.Rekeyed(ID, vm.addr(newPk));
        vm.prank(depositor);
        escrow.rekey(ID, vm.addr(newPk));

        bytes memory oldSig = _sign(claimPk, ID, recipient, block.timestamp);
        vm.expectRevert(ClaimEscrow.InvalidSignature.selector);
        escrow.claim(ID, recipient, block.timestamp, oldSig);

        escrow.claim(ID, recipient, block.timestamp, _sign(newPk, ID, recipient, block.timestamp));
        assertEq(usdc.balanceOf(recipient), AMOUNT);
    }

    function test_rekey_zeroSignerRejected() public {
        _deposit(ID, 0);
        vm.prank(depositor);
        vm.expectRevert(ClaimEscrow.ZeroAddress.selector);
        escrow.rekey(ID, address(0));
    }

    function test_setAutoRefund_setAndClear() public {
        _deposit(ID, 0);
        uint40 at = uint40(block.timestamp + 7 days);
        vm.prank(depositor);
        escrow.setAutoRefund(ID, at);
        assertEq(escrow.getDeposit(ID).autoRefundAt, at);

        vm.prank(depositor);
        escrow.setAutoRefund(ID, 0);
        vm.warp(block.timestamp + 365 days);
        vm.expectRevert(ClaimEscrow.NotRefundable.selector);
        escrow.refundExpired(ID);
    }

    function test_setAutoRefund_pastRejected() public {
        _deposit(ID, 0);
        vm.prank(depositor);
        vm.expectRevert(ClaimEscrow.InvalidAutoRefund.selector);
        escrow.setAutoRefund(ID, uint40(block.timestamp));
    }

    function test_controls_onFinishedDepositRevert() public {
        _deposit(ID, 0);
        vm.startPrank(depositor);
        escrow.refund(ID);
        vm.expectRevert(ClaimEscrow.NotPending.selector);
        escrow.rekey(ID, claimSigner);
        vm.expectRevert(ClaimEscrow.NotPending.selector);
        escrow.setAutoRefund(ID, 0);
        vm.expectRevert(ClaimEscrow.NotPending.selector);
        escrow.refund(ID);
        vm.stopPrank();
    }

    function test_unknownIdReverts() public {
        vm.expectRevert(ClaimEscrow.NotPending.selector);
        escrow.refundExpired(keccak256("nope"));
    }

    // -------------------------------------------------------- no admin path; claim needs nothing else

    /// there is no admin surface — common admin selectors do not exist on the contract.
    function test_noAdminSelectors() public {
        bytes[] memory calls = new bytes[](8);
        calls[0] = abi.encodeWithSignature("owner()");
        calls[1] = abi.encodeWithSignature("transferOwnership(address)", stranger);
        calls[2] = abi.encodeWithSignature("pause()");
        calls[3] = abi.encodeWithSignature("upgradeToAndCall(address,bytes)", stranger, "");
        calls[4] = abi.encodeWithSignature("sweep(address,address)", address(usdc), stranger);
        calls[5] = abi.encodeWithSignature("rescue(address,address,uint256)", address(usdc), stranger, 1);
        calls[6] = abi.encodeWithSignature("setToken(address,bool)", address(usdc), false);
        calls[7] = abi.encodeWithSignature("withdraw(address,uint256)", address(usdc), 1);
        _deposit(ID, 0);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok,) = address(escrow).call(calls[i]);
            assertFalse(ok);
        }
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT + TIP);
    }

    /// tokens sent directly (not via deposit) are unreachable by anyone — the price of no sweep.
    function test_strayTokensStayPut() public {
        usdc.mint(address(escrow), 5e6);
        _deposit(ID, 0);
        vm.prank(depositor);
        escrow.refund(ID);
        assertEq(usdc.balanceOf(address(escrow)), 5e6);
    }

    /// the whole claim needs only the escrow, the token and the key from the link —
    /// no oracle, registry, proxy or Omniflow contract. Here nothing else is deployed.
    function test_claimWorksWithOnlyEscrowTokenAndKey() public {
        _deposit(ID, 0);
        address self = makeAddr("own-wallet");
        bytes memory sig = _sign(claimPk, ID, self, block.timestamp + 365 days);
        vm.warp(block.timestamp + 364 days);
        vm.prank(self);
        escrow.claim(ID, self, block.timestamp + 1 days, sig);
        assertEq(usdc.balanceOf(self), AMOUNT + TIP);
    }
}
