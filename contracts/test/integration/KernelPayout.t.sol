// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ECDSA} from "solady/utils/ECDSA.sol";

import {Kernel} from "kernel/Kernel.sol";
import {KernelFactory} from "kernel/factory/KernelFactory.sol";
import {WeightedECDSAValidator} from "kernel/validator/WeightedECDSAValidator.sol";
import {IEntryPoint} from "kernel/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "kernel/interfaces/PackedUserOperation.sol";
import {IHook, IValidator} from "kernel/interfaces/IERC7579Modules.sol";
import {ValidatorLib} from "kernel/utils/ValidationTypeLib.sol";
import {ExecLib} from "kernel/utils/ExecLib.sol";
import {Execution} from "kernel/types/Structs.sol";
import {ExecMode, ValidationId, ExecModePayload} from "kernel/types/Types.sol";
import {CALLTYPE_BATCH, EXECTYPE_TRY, EXEC_MODE_DEFAULT} from "kernel/types/Constants.sol";
import {EntryPointLib} from "kernel-test/base/erc4337Util.sol";

import {ClaimEscrow} from "../../src/ClaimEscrow.sol";
import {MockUSDC} from "../mocks/MockTokens.sol";

/// End-to-end on a local chain, no network: the organisation's Kernel v3.3 account with
/// WeightedECDSAValidator (2 of 3, delay 0) pays a batch — two direct transfers and one escrow deposit —
/// only when two approvers signed.
contract KernelPayoutTest is Test {
    IEntryPoint entryPoint;
    KernelFactory factory;
    WeightedECDSAValidator weighted;
    Kernel account;
    MockUSDC usdc;
    ClaimEscrow escrow;

    uint256[3] approverPks;
    address[3] approvers;
    uint256 outsiderPk = 0x0BAD;

    address alice = makeAddr("alice-eoa");
    address bob = makeAddr("bob-eoa");
    uint256 claimPk = 0xC1A1;
    address bundler = makeAddr("bundler");

    function setUp() public {
        if (block.chainid == 42161 || block.chainid == 421614) {
            // Fork of a live Arbitrum network: use the deployed bytecode (verified on Sourcify), not our build.
            entryPoint = IEntryPoint(0x0000000071727De22E5E9d8BAf0edAc6f37da032);
            factory = KernelFactory(0x2577507b78c2008Ff367261CB6285d44ba5eF2E9); // Kernel 0.3.3
            weighted = WeightedECDSAValidator(0xeD89244160CfE273800B58b1B534031699dFeEEE);
            require(address(factory.implementation()) == 0xd6CEDDe84be40893d153Be9d467CD6aD37875b28, "unexpected impl");
        } else {
            entryPoint = IEntryPoint(EntryPointLib.deploy());
            Kernel impl = new Kernel(entryPoint);
            factory = new KernelFactory(address(impl));
            weighted = new WeightedECDSAValidator();
        }
        usdc = new MockUSDC();
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        escrow = new ClaimEscrow(tokens);

        approverPks = [uint256(0xA11CE), uint256(0xB0B0), uint256(0xCA11)];
        for (uint256 i; i < 3; ++i) {
            approvers[i] = vm.addr(approverPks[i]);
        }

        // WeightedECDSAValidator requires guardians sorted by descending address.
        address[] memory guardians = new address[](3);
        uint24[] memory weights = new uint24[](3);
        address[3] memory sorted = _sortedDesc(approvers);
        for (uint256 i; i < 3; ++i) {
            guardians[i] = sorted[i];
            weights[i] = 1;
        }
        bytes memory validatorData = abi.encode(guardians, weights, uint24(2), uint48(0));
        ValidationId root = ValidatorLib.validatorToIdentifier(IValidator(address(weighted)));
        bytes memory initData = abi.encodeWithSelector(
            Kernel.initialize.selector, root, IHook(address(0)), validatorData, hex"", new bytes[](0)
        );
        account = Kernel(payable(factory.createAccount(initData, bytes32(0))));

        vm.deal(address(account), 10 ether); // gas prefund; the paymaster is out of this test
        usdc.mint(address(account), 100_000e6);
    }

    // ------------------------------------------------------------------ helpers

    function _sortedDesc(address[3] memory a) internal pure returns (address[3] memory) {
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (a[j] > a[i]) (a[i], a[j]) = (a[j], a[i]);
            }
        }
        return a;
    }

    function _batch(Execution[] memory execs) internal pure returns (bytes memory) {
        ExecMode mode = ExecLib.encode(CALLTYPE_BATCH, EXECTYPE_TRY, EXEC_MODE_DEFAULT, ExecModePayload.wrap(0));
        return abi.encodeWithSelector(Kernel.execute.selector, mode, ExecLib.encodeBatch(execs));
    }

    function _payoutCallData(bytes32 depositId, address transferTo2) internal view returns (bytes memory) {
        Execution[] memory execs = new Execution[](4);
        execs[0] = Execution(address(usdc), 0, abi.encodeCall(usdc.transfer, (alice, 1_000e6)));
        execs[1] = Execution(address(usdc), 0, abi.encodeCall(usdc.transfer, (transferTo2, 2_000e6)));
        execs[2] = Execution(address(usdc), 0, abi.encodeCall(usdc.approve, (address(escrow), 3_001e6)));
        execs[3] = Execution(
            address(escrow),
            0,
            abi.encodeCall(escrow.deposit, (depositId, address(usdc), 3_000e6, 1e6, vm.addr(claimPk), 0))
        );
        return _batch(execs);
    }

    function _op(bytes memory callData) internal view returns (PackedUserOperation memory op) {
        op.sender = address(account);
        op.nonce = entryPoint.getNonce(address(account), 0); // key 0 = root validator
        op.callData = callData;
        op.accountGasLimits = bytes32((uint256(2_000_000) << 128) | uint256(2_000_000));
        op.preVerificationGas = 100_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(1 gwei));
    }

    /// EIP-712 digest of Approve(callDataAndNonceHash) in the validator's domain — what an approver signs.
    function _approveDigest(PackedUserOperation memory op) internal view returns (bytes32) {
        bytes32 callDataAndNonceHash = keccak256(abi.encode(op.sender, op.callData, op.nonce));
        bytes32 structHash =
            keccak256(abi.encode(keccak256("Approve(bytes32 callDataAndNonceHash)"), callDataAndNonceHash));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("WeightedECDSAValidator"),
                keccak256("0.0.3"),
                block.chainid,
                address(weighted)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _signApprove(uint256 pk, PackedUserOperation memory op) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _approveDigest(op));
        return abi.encodePacked(r, s, v);
    }

    function _signUserOp(uint256 pk, PackedUserOperation memory op) internal view returns (bytes memory) {
        bytes32 h = ECDSA.toEthSignedMessageHash(entryPoint.getUserOpHash(op));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        return abi.encodePacked(r, s, v);
    }

    /// Approver 0 approves the hash, approver 1 signs the final userOpHash — the 2-of-3 flow.
    function _twoOfThree(PackedUserOperation memory op) internal view returns (bytes memory) {
        return abi.encodePacked(_signApprove(approverPks[0], op), _signUserOp(approverPks[1], op));
    }

    function _handle(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        entryPoint.handleOps(ops, payable(bundler));
    }

    // -------------------------------------------------------------------- tests

    /// With two approvals the batch pays two EOAs and funds one escrow deposit.
    function test_twoOfThree_executesPayoutBatch() public {
        bytes32 depositId = keccak256(abi.encode(address(account), "payout-1", "row-3"));
        PackedUserOperation memory op = _op(_payoutCallData(depositId, bob));
        op.signature = _twoOfThree(op);
        _handle(op);

        assertEq(usdc.balanceOf(alice), 1_000e6);
        assertEq(usdc.balanceOf(bob), 2_000e6);
        assertEq(usdc.balanceOf(address(escrow)), 3_001e6);
        ClaimEscrow.Deposit memory d = escrow.getDeposit(depositId);
        assertEq(d.depositor, address(account)); // refunds can only ever go back to the organisation
        assertEq(uint8(d.status), uint8(ClaimEscrow.Status.Pending));
        assertEq(usdc.balanceOf(address(account)), 100_000e6 - 6_001e6);

        // The recipient without a wallet claims with the key from the link; anyone submits.
        address newWallet = makeAddr("privy-embedded-wallet");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(claimPk, escrow.claimDigest(depositId, newWallet, block.timestamp));
        vm.prank(bundler);
        escrow.claim(depositId, newWallet, block.timestamp, abi.encodePacked(r, s, v));
        assertEq(usdc.balanceOf(newWallet), 3_000e6);
    }

    /// one approver alone cannot move money.
    function test_oneApprover_rejected() public {
        PackedUserOperation memory op = _op(_payoutCallData(keccak256("d"), bob));
        op.signature = _signUserOp(approverPks[0], op);
        vm.expectRevert();
        _handle(op);
        assertEq(usdc.balanceOf(alice), 0);
    }

    /// the same approver signing twice does not count twice.
    function test_sameApproverTwice_rejected() public {
        PackedUserOperation memory op = _op(_payoutCallData(keccak256("d"), bob));
        op.signature = abi.encodePacked(_signApprove(approverPks[0], op), _signUserOp(approverPks[0], op));
        vm.expectRevert();
        _handle(op);
        assertEq(usdc.balanceOf(alice), 0);
    }

    /// a compromised backend holds no approver key — its own signatures weigh nothing.
    function test_backendKey_rejected() public {
        PackedUserOperation memory op = _op(_payoutCallData(keccak256("d"), bob));
        op.signature = abi.encodePacked(_signApprove(outsiderPk, op), _signUserOp(outsiderPk, op));
        vm.expectRevert();
        _handle(op);
        op.signature = abi.encodePacked(_signApprove(approverPks[0], op), _signUserOp(outsiderPk, op));
        vm.expectRevert();
        _handle(op);
        assertEq(usdc.balanceOf(alice), 0);
    }

    /// approvals are bound to the calldata — the backend cannot swap a recipient after signing.
    function test_approvalsBoundToCallData() public {
        PackedUserOperation memory approved = _op(_payoutCallData(keccak256("d"), bob));
        bytes memory sigs = _twoOfThree(approved);

        address attacker = makeAddr("attacker");
        PackedUserOperation memory swapped = _op(_payoutCallData(keccak256("d"), attacker));
        swapped.signature = sigs;
        vm.expectRevert();
        _handle(swapped);
        assertEq(usdc.balanceOf(attacker), 0);
    }

    /// Double-send guard, layer 1: one approved operation executes once; resubmitting it is rejected.
    function test_sameOperationOnlyOnce() public {
        PackedUserOperation memory op = _op(_payoutCallData(keccak256("d"), bob));
        op.signature = _twoOfThree(op);
        _handle(op);
        vm.expectRevert();
        _handle(op);
        assertEq(usdc.balanceOf(alice), 1_000e6);
    }

    /// Double-send guard, layer 2: a second batch reusing a deposit id fails on that row only (EXECTYPE_TRY);
    /// its money stays on the account.
    function test_duplicateDepositRowFailsAlone() public {
        bytes32 depositId = keccak256("same-row");
        PackedUserOperation memory op1 = _op(_payoutCallData(depositId, bob));
        op1.signature = _twoOfThree(op1);
        _handle(op1);

        PackedUserOperation memory op2 = _op(_payoutCallData(depositId, bob));
        op2.signature = _twoOfThree(op2);
        vm.recordLogs();
        _handle(op2);

        assertEq(usdc.balanceOf(alice), 2_000e6); // transfer rows ran twice — that is layer 3's job (backend)
        assertEq(usdc.balanceOf(address(escrow)), 3_001e6); // deposit did not
        assertTrue(_sawTryExecuteUnsuccessful(vm.getRecordedLogs()));
    }

    /// A blocklisted address fails its own row; the rest of the batch is paid.
    function test_tryExec_blockedRecipientRowFailsOthersPaid() public {
        usdc.setBlocked(bob, true);
        PackedUserOperation memory op = _op(_payoutCallData(keccak256("d"), bob));
        op.signature = _twoOfThree(op);
        vm.recordLogs();
        _handle(op);

        assertEq(usdc.balanceOf(alice), 1_000e6);
        assertEq(usdc.balanceOf(bob), 0);
        assertEq(usdc.balanceOf(address(escrow)), 3_001e6);
        assertEq(usdc.balanceOf(address(account)), 100_000e6 - 4_001e6); // bob's 2 000 stayed
        assertTrue(_sawTryExecuteUnsuccessful(vm.getRecordedLogs()));
    }

    /// revoking needs the same 2-of-3 and returns money to the account only.
    function test_refundViaTwoOfThree() public {
        bytes32 depositId = keccak256("to-revoke");
        PackedUserOperation memory pay = _op(_payoutCallData(depositId, bob));
        pay.signature = _twoOfThree(pay);
        _handle(pay);

        Execution[] memory execs = new Execution[](1);
        execs[0] = Execution(address(escrow), 0, abi.encodeCall(escrow.refund, (depositId)));
        PackedUserOperation memory revoke = _op(_batch(execs));
        revoke.signature = _signUserOp(approverPks[2], revoke);
        vm.expectRevert();
        _handle(revoke); // one approver is not enough

        revoke.signature = abi.encodePacked(_signApprove(approverPks[2], revoke), _signUserOp(approverPks[0], revoke));
        _handle(revoke);
        assertEq(usdc.balanceOf(address(account)), 100_000e6 - 3_000e6); // 3 001 back, 3 000 paid to alice+bob
        assertEq(uint8(escrow.getDeposit(depositId).status), uint8(ClaimEscrow.Status.Refunded));
    }

    /// nobody outside can change the approver set — renew() acts on the caller's own storage.
    function test_guardianSetNotChangeableFromOutside() public {
        address[] memory g = new address[](1);
        g[0] = vm.addr(outsiderPk);
        uint24[] memory w = new uint24[](1);
        w[0] = 10;
        vm.prank(vm.addr(outsiderPk));
        vm.expectRevert();
        weighted.renew(g, w, 1, 0);

        (uint24 totalWeight, uint24 threshold,,) = weighted.weightedStorage(address(account));
        assertEq(totalWeight, 3);
        assertEq(threshold, 2);
    }

    /// Account address is deterministic from factory + init data (what approvers must check).
    function test_accountAddressIsDeterministic() public view {
        address[] memory guardians = new address[](3);
        uint24[] memory weights = new uint24[](3);
        address[3] memory sorted = _sortedDesc(approvers);
        for (uint256 i; i < 3; ++i) {
            guardians[i] = sorted[i];
            weights[i] = 1;
        }
        bytes memory initData = abi.encodeWithSelector(
            Kernel.initialize.selector,
            ValidatorLib.validatorToIdentifier(IValidator(address(weighted))),
            IHook(address(0)),
            abi.encode(guardians, weights, uint24(2), uint48(0)),
            hex"",
            new bytes[](0)
        );
        assertEq(factory.getAddress(initData, bytes32(0)), address(account));
    }

    function _sawTryExecuteUnsuccessful(Vm.Log[] memory logs) internal pure returns (bool) {
        bytes32 topic = keccak256("TryExecuteUnsuccessful(uint256,bytes)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) return true;
        }
        return false;
    }
}
