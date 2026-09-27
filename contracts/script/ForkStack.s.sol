// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {Kernel} from "kernel/Kernel.sol";
import {KernelFactory} from "kernel/factory/KernelFactory.sol";
import {IHook, IValidator} from "kernel/interfaces/IERC7579Modules.sol";
import {ValidatorLib} from "kernel/utils/ValidationTypeLib.sol";
import {ClaimEscrow} from "../src/ClaimEscrow.sol";

/// For an anvil FORK of Arbitrum Sepolia: uses the deployed EntryPoint v0.7, Kernel 0.3.1 factory
/// and WeightedECDSAValidator; deploys only our ClaimEscrow for Circle's testnet USDC.
/// Env: APPROVERS (comma-separated), THRESHOLD, OUT.
contract ForkStack is Script {
    address constant ENTRYPOINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant FACTORY_031 = 0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419;
    address constant WEIGHTED = 0xeD89244160CfE273800B58b1B534031699dFeEEE;
    address constant USDC_SEPOLIA = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;

    function run() external {
        require(block.chainid == 421614, "ForkStack targets an Arbitrum Sepolia fork only");
        address[] memory approvers = vm.envOr("APPROVERS", ",", new address[](0));
        uint24 threshold = uint24(vm.envOr("THRESHOLD", uint256(1)));
        address[] memory sorted = _sortDesc(approvers);
        uint24[] memory weights = new uint24[](sorted.length);
        for (uint256 i; i < sorted.length; ++i) weights[i] = 1;
        bytes memory initData = abi.encodeWithSelector(
            Kernel.initialize.selector,
            ValidatorLib.validatorToIdentifier(IValidator(WEIGHTED)),
            IHook(address(0)),
            abi.encode(sorted, weights, threshold, uint48(0)),
            hex"",
            new bytes[](0)
        );

        vm.startBroadcast();
        address[] memory tokens = new address[](1);
        tokens[0] = USDC_SEPOLIA;
        ClaimEscrow escrow = new ClaimEscrow(tokens);
        address account = approvers.length > 0 ? KernelFactory(FACTORY_031).createAccount(initData, bytes32(0)) : address(0);
        vm.stopBroadcast();

        string memory o = "deploy";
        vm.serializeAddress(o, "entryPoint", ENTRYPOINT);
        vm.serializeAddress(o, "factory", FACTORY_031);
        vm.serializeAddress(o, "validator", WEIGHTED);
        vm.serializeAddress(o, "token", USDC_SEPOLIA);
        vm.serializeAddress(o, "escrow", address(escrow));
        vm.writeJson(vm.serializeAddress(o, "account", account), vm.envString("OUT"));
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
