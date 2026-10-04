// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";

/// Plain 6-decimals token standing in for USDC.
contract MockUSDC is ERC20 {
    mapping(address => bool) public blocked;

    function name() public pure override returns (string memory) {
        return "Mock USDC";
    }

    /// The same symbol as the token it stands for: the dashboard, the reports and the claim page must name it alike.
    /// name() still says it is a mock.
    function symbol() public pure override returns (string memory) {
        return "USDC";
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// USDC-style blocklist: transfers to or from a blocked address revert.
    function setBlocked(address who, bool value) external {
        blocked[who] = value;
    }

    function _beforeTokenTransfer(address from, address to, uint256) internal view override {
        require(!blocked[from] && !blocked[to], "blocked");
    }
}

/// Takes 1% on every transfer — must be rejected by the escrow's balance-delta check.
contract FeeOnTransferToken is ERC20 {
    function name() public pure override returns (string memory) {
        return "Fee Token";
    }

    function symbol() public pure override returns (string memory) {
        return "FEE";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 fee = amount / 100;
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount - fee);
        if (fee != 0) _burn(from, fee);
        return true;
    }
}
