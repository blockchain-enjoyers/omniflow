// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Kernel} from "kernel/Kernel.sol";
import {IHook, IValidator} from "kernel/interfaces/IERC7579Modules.sol";
import {ValidatorLib} from "kernel/utils/ValidationTypeLib.sol";
import {ExecLib} from "kernel/utils/ExecLib.sol";
import {Execution} from "kernel/types/Structs.sol";
import {ExecMode, ExecModePayload} from "kernel/types/Types.sol";
import {CALLTYPE_BATCH, EXECTYPE_TRY, EXEC_MODE_DEFAULT} from "kernel/types/Constants.sol";

import {ClaimEscrow} from "../src/ClaimEscrow.sol";
import {MockUSDC} from "./mocks/MockTokens.sol";

/// Checks that omniflow/packages/shared (TypeScript) produces exactly what the chain expects:
/// fixture written by packages/shared/test/fixture.test.ts.
contract SharedFixtureTest is Test {
    using stdJson for string;

    string json;

    function setUp() public {
        json = vm.readFile("test/fixtures/shared.json");
        assertEq(json.readUint(".chainId"), block.chainid, "fixture chain id");
    }

    /// TS depositId == keccak256(abi.encode(account, payoutId, rowId)).
    function test_depositIdMatches() public view {
        bytes32 expected = keccak256(abi.encode(json.readAddress(".account"), "payout-1", "row-2"));
        assertEq(json.readBytes32(".depositId"), expected);
    }

    /// TS buildBatchCallData == Kernel.execute(BATCH|TRY, ExecLib.encodeBatch(...)) built with Kernel's own encoders.
    function test_batchCallDataMatchesKernelEncoding() public view {
        address token = json.readAddress(".token");
        address escrow = json.readAddress(".escrow");
        uint256 amount = json.readUint(".depositAmount");
        uint256 tip = json.readUint(".tip");

        Execution[] memory execs = new Execution[](3);
        execs[0] = Execution(
            token,
            0,
            abi.encodeWithSignature(
                "transfer(address,uint256)", json.readAddress(".transferTo"), json.readUint(".transferAmount")
            )
        );
        execs[1] = Execution(token, 0, abi.encodeWithSignature("approve(address,uint256)", escrow, amount + tip));
        execs[2] = Execution(
            escrow,
            0,
            abi.encodeCall(
                ClaimEscrow.deposit,
                (json.readBytes32(".depositId"), token, uint96(amount), uint96(tip), json.readAddress(".claimSigner"), 0)
            )
        );
        ExecMode mode = ExecLib.encode(CALLTYPE_BATCH, EXECTYPE_TRY, EXEC_MODE_DEFAULT, ExecModePayload.wrap(0));
        bytes memory expected = abi.encodeWithSelector(Kernel.execute.selector, mode, ExecLib.encodeBatch(execs));
        assertEq(json.readBytes(".callData"), expected);
    }

    /// TS callDataAndNonceHash == WeightedECDSAValidator's keccak256(abi.encode(sender, callData, nonce)).
    function test_callDataAndNonceHashMatches() public view {
        bytes32 expected =
            keccak256(abi.encode(json.readAddress(".account"), json.readBytes(".callData"), json.readUint(".nonce")));
        assertEq(json.readBytes32(".callDataAndNonceHash"), expected);
    }

    /// TS approveTypedData digest == the validator's EIP-712 digest; the signature recovers to the approver.
    function test_approveDigestAndSignature() public view {
        bytes32 structHash = keccak256(
            abi.encode(keccak256("Approve(bytes32 callDataAndNonceHash)"), json.readBytes32(".callDataAndNonceHash"))
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("WeightedECDSAValidator"),
                keccak256("0.0.3"),
                block.chainid,
                json.readAddress(".validator")
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        assertEq(json.readBytes32(".approveDigest"), digest);

        bytes memory sig = json.readBytes(".approveSignature");
        (bytes32 r, bytes32 s) = abi.decode(sig, (bytes32, bytes32));
        uint8 v = uint8(sig[64]);
        assertEq(ecrecover(digest, v, r, s), json.readAddress(".approver"));
    }

    /// TS kernelInitData == Kernel.initialize(validatorToIdentifier(v), hook 0, abi.encode(sortedDesc, weights, threshold, 0), "", []).
    function test_kernelInitDataMatches() public view {
        address[] memory sorted = new address[](3);
        sorted[0] = address(0x333);
        sorted[1] = address(0x222);
        sorted[2] = address(0x111);
        uint24[] memory weights = new uint24[](3);
        weights[0] = 1;
        weights[1] = 1;
        weights[2] = 1;
        bytes memory expected = abi.encodeWithSelector(
            Kernel.initialize.selector,
            ValidatorLib.validatorToIdentifier(IValidator(json.readAddress(".validator"))),
            IHook(address(0)),
            abi.encode(sorted, weights, uint24(2), uint48(0)),
            hex"",
            new bytes[](0)
        );
        assertEq(json.readBytes(".initData"), expected);
    }

    /// A claim signed in TypeScript with the key from the link is redeemed by the real ClaimEscrow.
    function test_tsClaimSignatureRedeemsOnEscrow() public {
        address token = json.readAddress(".token");
        address escrowAddr = json.readAddress(".escrow");
        address account = json.readAddress(".account");
        deployCodeTo("MockTokens.sol:MockUSDC", token);
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        deployCodeTo("ClaimEscrow.sol:ClaimEscrow", abi.encode(tokens), escrowAddr);
        ClaimEscrow escrow = ClaimEscrow(escrowAddr);

        uint96 amount = uint96(json.readUint(".depositAmount"));
        uint96 tip = uint96(json.readUint(".tip"));
        MockUSDC(token).mint(account, uint256(amount) + tip);
        vm.startPrank(account);
        MockUSDC(token).approve(escrowAddr, uint256(amount) + tip);
        escrow.deposit(json.readBytes32(".depositId"), token, amount, tip, json.readAddress(".claimSigner"), 0);
        vm.stopPrank();

        address recipient = json.readAddress(".claimRecipient");
        uint256 deadline = json.readUint(".claimDeadline");
        assertEq(escrow.claimDigest(json.readBytes32(".depositId"), recipient, deadline), json.readBytes32(".claimDigest"));
        escrow.claim(json.readBytes32(".depositId"), recipient, deadline, json.readBytes(".claimSignature"));
        assertEq(MockUSDC(token).balanceOf(recipient), amount);
    }
}
