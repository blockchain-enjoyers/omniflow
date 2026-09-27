// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ClaimEscrow} from "../src/ClaimEscrow.sol";

/// Deploys ClaimEscrow through the deterministic CREATE2 deployer — same address on every chain
/// for the same token list. Env: ESCROW_TOKENS (comma-separated).
/// Mainnet only with the owner's explicit permission; verify every token with eth_getCode first.
contract DeployEscrow is Script {
    function run() external returns (ClaimEscrow escrow) {
        address[] memory tokens = vm.envAddress("ESCROW_TOKENS", ",");
        for (uint256 i; i < tokens.length; ++i) {
            require(tokens[i].code.length > 0, "token has no code on this chain");
        }
        vm.startBroadcast();
        escrow = new ClaimEscrow{salt: bytes32(0)}(tokens);
        vm.stopBroadcast();
        console.log("ClaimEscrow", address(escrow));
    }
}
