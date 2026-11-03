// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

interface IOwned {
    function owner() external view returns (address);
}

interface IWired {
    function coverManager() external view returns (address);
    function claimsEngine() external view returns (address);
    function disputeModule() external view returns (address);
    function moduleFactory() external view returns (address);
    function vaultFactory() external view returns (address);
}

/// @notice Promotes deployments/<chainId>.pending.json to deployments/<chainId>.json once the
///         deployment is confirmed on-chain. Run without --broadcast; it only reads the chain.
/// @dev Deploy.s.sol writes the pending file before forge sends its transactions, so a failed or
///      partial broadcast would otherwise leave addresses that hold nothing. This checks every
///      address has code and the modules point at each other, then writes the final file.
contract RecordDeployment is Script {
    string[15] internal contractKeys = [
        "usdg",
        "tsla",
        "amzn",
        "nvda",
        "oracle",
        "router",
        "registry",
        "factory",
        "pool",
        "bond",
        "coverManager",
        "claimsEngine",
        "disputeModule",
        "bountyBoard",
        "moduleFactory"
    ];

    function run() external {
        // Same directory Deploy.s.sol wrote to (see DEPLOYMENTS_DIR there).
        string memory dir = string.concat(
            vm.projectRoot(), "/", vm.envOr("DEPLOYMENTS_DIR", string("deployments")), "/"
        );
        string memory id = vm.toString(block.chainid);
        string memory pending = string.concat(dir, id, ".pending.json");
        // reading and promoting our own deployment file is the point of this script
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(pending);

        require(
            vm.parseJsonUint(json, ".chainId") == block.chainid, "pending file is for another chain"
        );
        for (uint256 i; i < contractKeys.length; ++i) {
            address a = vm.parseJsonAddress(json, string.concat(".", contractKeys[i]));
            require(a.code.length > 0, string.concat("no code at ", contractKeys[i]));
        }
        _checkWiring(json);
        // GateAnchor is optional (GATE_ANCHOR in Deploy.s.sol).
        if (vm.keyExistsJson(json, ".gateAnchor")) {
            require(
                vm.parseJsonAddress(json, ".gateAnchor").code.length > 0, "no code at gateAnchor"
            );
        }

        string memory path = string.concat(dir, id, ".json");
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.writeFile(path, json);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.removeFile(pending);
        console2.log("Verified on-chain and wrote", path);
    }

    function _checkWiring(string memory json) internal view {
        address manager = vm.parseJsonAddress(json, ".coverManager");
        address claims = vm.parseJsonAddress(json, ".claimsEngine");
        address disputes = vm.parseJsonAddress(json, ".disputeModule");
        require(
            IWired(vm.parseJsonAddress(json, ".factory")).coverManager() == manager,
            "factory not wired"
        );
        require(
            IWired(vm.parseJsonAddress(json, ".pool")).claimsEngine() == claims, "pool not wired"
        );
        require(
            IWired(vm.parseJsonAddress(json, ".bond")).claimsEngine() == claims, "bond not wired"
        );
        require(IWired(manager).claimsEngine() == claims, "cover manager not wired");
        require(IWired(claims).disputeModule() == disputes, "claims engine not wired");
        address moduleFactory = vm.parseJsonAddress(json, ".moduleFactory");
        require(
            IWired(manager).moduleFactory() == moduleFactory, "cover manager has no module factory"
        );
        require(
            IWired(moduleFactory).vaultFactory() == vm.parseJsonAddress(json, ".factory"),
            "module factory not wired"
        );
        require(
            IOwned(vm.parseJsonAddress(json, ".registry")).owner() != address(0),
            "registry has no owner"
        );
    }
}
