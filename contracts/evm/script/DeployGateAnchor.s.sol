// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {GateAnchor} from "../src/GateAnchor.sol";

/// @notice Deploys GateAnchor, the payment gate's hash record, on its own: for a chain whose
///         protocol is already deployed (Deploy.s.sol deploys it too when GATE_ANCHOR is set).
///         Nothing else changes, and no deployment file is written: give the keeper the printed
///         address as GATE_ANCHOR_ADDRESS (apps/api/GATE.md).
/// @dev Environment:
///      DEPLOYER_PRIVATE_KEY  required; the deployer owns the anchor (Ownable2Step)
///      GATE_ANCHOR_POSTER    the address allowed to post (the keeper's GATE_ANCHOR_KEY); none if
///                            unset, and the owner sets one later with setPoster
///      Run: forge script script/DeployGateAnchor.s.sol --rpc-url <rpc> --broadcast --slow
contract DeployGateAnchor is Script {
    function run() external returns (GateAnchor anchor) {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address poster = vm.envOr("GATE_ANCHOR_POSTER", address(0));
        vm.startBroadcast(key);
        anchor = new GateAnchor(vm.addr(key));
        if (poster != address(0)) anchor.setPoster(poster, true);
        vm.stopBroadcast();
        console2.log("GateAnchor     ", address(anchor));
        if (poster == address(0)) {
            console2.log("No poster set: call setPoster before the keeper posts");
        }
    }
}
