// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {Kernel} from "kernel/Kernel.sol";
import {KernelFactory} from "kernel/factory/KernelFactory.sol";
import {WeightedECDSAValidator} from "kernel/validator/WeightedECDSAValidator.sol";
import {IEntryPoint} from "kernel/interfaces/IEntryPoint.sol";
import {IHook, IValidator} from "kernel/interfaces/IERC7579Modules.sol";
import {ValidatorLib} from "kernel/utils/ValidationTypeLib.sol";
import {EntryPointLib} from "kernel-test/base/erc4337Util.sol";
import {ClaimEscrow} from "../src/ClaimEscrow.sol";
import {MockUSDC} from "../test/mocks/MockTokens.sol";

/// LOCAL CHAIN ONLY (anvil). Deploys the whole slice stack from source and an organisation account.
/// Env: APPROVERS (comma-separated, any order), THRESHOLD, OUT (json path).
contract LocalStack is Script {
    function run() external {
        address[] memory approvers = vm.envOr("APPROVERS", ",", new address[](0));
        uint24 threshold = uint24(vm.envOr("THRESHOLD", uint256(1)));
        require(block.chainid == 31337, "LocalStack is for anvil only");

        vm.startBroadcast();
        IEntryPoint ep = IEntryPoint(EntryPointLib.deploy());
        Kernel impl = new Kernel(ep);
        KernelFactory factory = new KernelFactory(address(impl));
        WeightedECDSAValidator weighted = new WeightedECDSAValidator();
        MockUSDC usdc = new MockUSDC();
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        ClaimEscrow escrow = new ClaimEscrow(tokens);

        address[] memory sorted = _sortDesc(approvers);
        uint24[] memory weights = new uint24[](sorted.length);
        for (uint256 i; i < sorted.length; ++i) weights[i] = 1;
        bytes memory initData = abi.encodeWithSelector(
            Kernel.initialize.selector,
            ValidatorLib.validatorToIdentifier(IValidator(address(weighted))),
            IHook(address(0)),
            abi.encode(sorted, weights, threshold, uint48(0)),
            hex"",
            new bytes[](0)
        );
        address account;
        if (approvers.length > 0) {
            account = factory.createAccount(initData, bytes32(0));
            usdc.mint(account, 1_000_000e6);
            payable(account).transfer(10 ether); // gas prefund when no paymaster is used
        }
        vm.stopBroadcast();

        string memory o = "deploy";
        vm.serializeAddress(o, "entryPoint", address(ep));
        vm.serializeAddress(o, "factory", address(factory));
        vm.serializeAddress(o, "validator", address(weighted));
        vm.serializeAddress(o, "token", address(usdc));
        vm.serializeAddress(o, "escrow", address(escrow));
        string memory out = vm.serializeAddress(o, "account", account);
        vm.writeJson(out, vm.envString("OUT"));
    }

    function _sortDesc(address[] memory a) internal pure returns (address[] memory) {
        for (uint256 i; i < a.length; ++i) {
            for (uint256 j = i + 1; j < a.length; ++j) {
                if (a[j] > a[i]) (a[i], a[j]) = (a[j], a[i]);
            }
        }
        return a;
    }
}
