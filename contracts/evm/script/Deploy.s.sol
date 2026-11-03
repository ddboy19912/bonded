// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BondedRegistry} from "../src/BondedRegistry.sol";
import {MandateVaultFactory} from "../src/MandateVaultFactory.sol";
import {MandateModuleFactory} from "../src/MandateModuleFactory.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {OperatorBond} from "../src/OperatorBond.sol";
import {CoverManager} from "../src/CoverManager.sol";
import {ClaimsEngine} from "../src/ClaimsEngine.sol";
import {DisputeModule, IDisputePayer} from "../src/DisputeModule.sol";
import {BountyBoard} from "../src/BountyBoard.sol";
import {GateAnchor} from "../src/GateAnchor.sol";
import {MockOracle} from "../src/oracles/MockOracle.sol";
import {TestToken} from "../src/testnet/TestToken.sol";
import {DemoRouter} from "../src/testnet/DemoRouter.sol";

/// @notice Deploys the demo market and the full Bonded protocol, wires every module, and
///         writes the addresses to deployments/<chainId>.pending.json. Run `script/deploy.sh`,
///         which then runs RecordDeployment to check the contracts on-chain and promote the file
///         to deployments/<chainId>.json.
/// @dev Environment:
///      DEPLOYER_PRIVATE_KEY  required; the deployer is the initial owner of everything
///      ATTESTER              Arena attester address (default: deployer)
///      COUNCIL               dispute council (default: deployer)
///      WAITING_PERIOD        cover waiting period in seconds (default: 1 day; the local smoke run uses 0)
///      WRITE_DEPLOYMENT      write the pending file (default: true). Only written with `--broadcast`.
///      GATE_ANCHOR           also deploy GateAnchor, the payment gate's hash record (default:
///                            false). It is separate from the protocol; DeployGateAnchor.s.sol
///                            adds it to a chain that is already deployed.
///      GATE_ANCHOR_POSTER    the address allowed to post to it (the keeper's GATE_ANCHOR_KEY);
///                            none if unset, and the owner sets one later with setPoster
///      Forge runs this script before it sends the transactions, so the pending file can't prove
///      anything was deployed; RecordDeployment does that check afterwards.
///      Ownership handover to a multisig happens after deployment (Ownable2Step).
contract Deploy is Script {
    struct Deployment {
        address usdg;
        address tsla;
        address amzn;
        address nvda;
        address oracle;
        address router;
        address registry;
        address factory;
        address pool;
        address bond;
        address coverManager;
        address claimsEngine;
        address disputeModule;
        address bountyBoard;
        address moduleFactory;
        /// Zero unless GATE_ANCHOR is set.
        address gateAnchor;
    }

    uint256 internal constant USDG_PRICE = 1e6;
    uint256 internal constant TSLA_PRICE = 250e6;
    uint256 internal constant AMZN_PRICE = 200e6;
    uint256 internal constant NVDA_PRICE = 180e6;

    function run() external returns (Deployment memory d) {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        address attester = vm.envOr("ATTESTER", deployer);
        address council = vm.envOr("COUNCIL", deployer);
        uint64 waitingPeriod = uint64(vm.envOr("WAITING_PERIOD", uint256(1 days)));

        vm.startBroadcast(key);
        _deployMarket(d, deployer);
        _deployProtocol(d, deployer, attester, council, waitingPeriod);
        if (vm.envOr("GATE_ANCHOR", false)) {
            d.gateAnchor =
                address(deployGateAnchor(deployer, vm.envOr("GATE_ANCHOR_POSTER", address(0))));
        }
        vm.stopBroadcast();

        _log(d);
        bool broadcasting = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);
        if (broadcasting && vm.envOr("WRITE_DEPLOYMENT", true)) _writePending(d);
        else console2.log("Dry run: no deployment file written");
    }

    /// @dev Test tokens with faucets, a mock oracle and an oracle-priced router with inventory.
    function _deployMarket(Deployment memory d, address deployer) internal {
        TestToken usdg = new TestToken("Test Global Dollar", "tUSDG", 6, 1_000_000);
        TestToken tsla = new TestToken("Test Tesla Stock Token", "tTSLA", 18, 1000);
        TestToken amzn = new TestToken("Test Amazon Stock Token", "tAMZN", 18, 1000);
        TestToken nvda = new TestToken("Test NVIDIA Stock Token", "tNVDA", 18, 1000);

        MockOracle oracle = new MockOracle(deployer);
        oracle.setPrice(address(usdg), USDG_PRICE);
        oracle.setPrice(address(tsla), TSLA_PRICE);
        oracle.setPrice(address(amzn), AMZN_PRICE);
        oracle.setPrice(address(nvda), NVDA_PRICE);

        DemoRouter router = new DemoRouter(oracle, 20);
        usdg.mint(address(router), 50_000_000e6);
        tsla.mint(address(router), 200_000e18);
        amzn.mint(address(router), 200_000e18);
        nvda.mint(address(router), 200_000e18);

        d.usdg = address(usdg);
        d.tsla = address(tsla);
        d.amzn = address(amzn);
        d.nvda = address(nvda);
        d.oracle = address(oracle);
        d.router = address(router);
    }

    function _deployProtocol(
        Deployment memory d,
        address deployer,
        address attester,
        address council,
        uint64 waitingPeriod
    ) internal {
        IERC20 base = IERC20(d.usdg);
        BondedRegistry registry = new BondedRegistry(deployer);
        MandateVaultFactory factory = new MandateVaultFactory(deployer, MockOracle(d.oracle));
        CoverPool pool =
            new CoverPool(base, deployer, 7 days, "Bonded Underwriting tUSDG", "bdUSDG");
        OperatorBond bond = new OperatorBond(base, registry, deployer, 7 days);
        BountyBoard board = new BountyBoard(base, registry);
        CoverManager manager =
            new CoverManager(deployer, registry, factory, pool, bond, deployer, address(board));
        ClaimsEngine claims = new ClaimsEngine(deployer, manager, pool, bond, factory);
        DisputeModule disputes = new DisputeModule(
            deployer, base, manager, IDisputePayer(address(claims)), council, 250e6
        );

        registry.setAttester(attester, true);
        factory.setCoverManager(address(manager));
        factory.setClaimsEngine(address(claims));
        pool.setCoverManager(manager);
        pool.setClaimsEngine(address(claims));
        bond.setCoverManager(manager);
        bond.setClaimsEngine(address(claims));
        manager.setClaimsEngine(address(claims));
        manager.setTerms(30 days, waitingPeriod);
        claims.setDisputeModule(address(disputes));

        // Deployed last so every address above stays where it was before the module existed.
        MandateModuleFactory moduleFactory = new MandateModuleFactory(factory);
        manager.setModuleFactory(address(moduleFactory));

        d.registry = address(registry);
        d.factory = address(factory);
        d.pool = address(pool);
        d.bond = address(bond);
        d.coverManager = address(manager);
        d.claimsEngine = address(claims);
        d.disputeModule = address(disputes);
        d.bountyBoard = address(board);
        d.moduleFactory = address(moduleFactory);
    }

    /// @dev GateAnchor owned by `owner`, with `poster` allowed to post unless it is zero. Called
    ///      inside a broadcast.
    function deployGateAnchor(address owner, address poster) internal returns (GateAnchor anchor) {
        anchor = new GateAnchor(owner);
        if (poster != address(0)) anchor.setPoster(poster, true);
    }

    function _writePending(Deployment memory d) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployedAtBlock", _chainBlockNumber());
        vm.serializeAddress(k, "usdg", d.usdg);
        vm.serializeAddress(k, "tsla", d.tsla);
        vm.serializeAddress(k, "amzn", d.amzn);
        vm.serializeAddress(k, "nvda", d.nvda);
        vm.serializeAddress(k, "oracle", d.oracle);
        vm.serializeAddress(k, "router", d.router);
        vm.serializeAddress(k, "registry", d.registry);
        vm.serializeAddress(k, "factory", d.factory);
        vm.serializeAddress(k, "pool", d.pool);
        vm.serializeAddress(k, "bond", d.bond);
        vm.serializeAddress(k, "coverManager", d.coverManager);
        vm.serializeAddress(k, "claimsEngine", d.claimsEngine);
        vm.serializeAddress(k, "disputeModule", d.disputeModule);
        vm.serializeAddress(k, "bountyBoard", d.bountyBoard);
        if (d.gateAnchor != address(0)) vm.serializeAddress(k, "gateAnchor", d.gateAnchor);
        string memory json = vm.serializeAddress(k, "moduleFactory", d.moduleFactory);
        // DEPLOYMENTS_DIR lets a throwaway local chain (the Arena sandbox) write somewhere
        // git-ignored, away from the committed files. It must stay under ./deployments
        // (foundry.toml's fs_permissions).
        string memory dir = string.concat(
            vm.projectRoot(), "/", vm.envOr("DEPLOYMENTS_DIR", string("deployments")), "/"
        );
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.createDir(dir, true);
        string memory path = string.concat(dir, vm.toString(block.chainid), ".pending.json");
        vm.writeJson(json, path);
        console2.log("Wrote", path);
    }

    /// @dev The chain's own block number, for indexers, read from the RPC just before the
    ///      transactions are sent (so it is a safe lower bound for event scans). `block.number`
    ///      won't do: on Arbitrum Sepolia it returns the parent chain's (Ethereum Sepolia) block,
    ///      and forge's simulator doesn't run the ArbSys precompile that would give the right one.
    function _chainBlockNumber() internal returns (uint256 n) {
        bytes memory raw = vm.rpc("eth_blockNumber", "[]");
        for (uint256 i; i < raw.length; ++i) {
            n = (n << 8) | uint8(raw[i]);
        }
    }

    function _log(Deployment memory d) internal pure {
        console2.log("tUSDG          ", d.usdg);
        console2.log("tTSLA          ", d.tsla);
        console2.log("Router         ", d.router);
        console2.log("BondedRegistry ", d.registry);
        console2.log("VaultFactory   ", d.factory);
        console2.log("CoverPool      ", d.pool);
        console2.log("OperatorBond   ", d.bond);
        console2.log("CoverManager   ", d.coverManager);
        console2.log("ClaimsEngine   ", d.claimsEngine);
        console2.log("DisputeModule  ", d.disputeModule);
        console2.log("BountyBoard    ", d.bountyBoard);
        console2.log("ModuleFactory  ", d.moduleFactory);
        if (d.gateAnchor != address(0)) console2.log("GateAnchor     ", d.gateAnchor);
    }
}
