// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockOracle} from "../src/oracles/MockOracle.sol";
import {TestToken} from "../src/testnet/TestToken.sol";
import {DemoRouter} from "../src/testnet/DemoRouter.sol";

contract DemoRouterSkewTest is Test {
    TestToken internal usdg;
    TestToken internal tsla;
    TestToken internal nvda;
    MockOracle internal oracle;
    DemoRouter internal router;

    function setUp() public {
        usdg = new TestToken("Test USDG", "tUSDG", 6, 100_000);
        tsla = new TestToken("Test Tesla", "tTSLA", 18, 1000);
        nvda = new TestToken("Test Nvidia", "tNVDA", 18, 1000);
        oracle = new MockOracle(address(this));
        oracle.setPrice(address(usdg), 1e6);
        oracle.setPrice(address(tsla), 250e6);
        oracle.setPrice(address(nvda), 180e6);
        router = new DemoRouter(oracle, 20);
        tsla.mint(address(router), 10_000e18);
    }

    function test_SwapAppliesFeeAndSkewWithoutChangingOracleValue() public {
        router.setSkew(address(usdg), address(tsla), 250);
        usdg.faucet(1000e6);
        usdg.approve(address(router), 1000e6);
        uint256 quoted = router.quote(address(usdg), address(tsla), 1000e6);
        assertEq(quoted, 3.892e18); // 4 TSLA less 20 bps fee and 250 bps skew.
        uint256 received = router.swap(address(usdg), address(tsla), 1000e6, address(this));
        assertEq(received, quoted);
        assertEq(tsla.balanceOf(address(this)), quoted);
        assertEq(oracle.valueInUsd6(address(tsla), received), 973e6);
        assertEq(oracle.valueInUsd6(address(tsla), 1e18), 250e6);
    }

    function test_ResetRestoresFeeOnlyQuote() public {
        uint256 cleanQuote = router.quote(address(usdg), address(tsla), 1000e6);
        router.setSkew(address(usdg), address(tsla), 500);
        assertLt(router.quote(address(usdg), address(tsla), 1000e6), cleanQuote);
        router.setSkew(address(usdg), address(tsla), 0);
        assertEq(router.skewBps(address(usdg), address(tsla)), 0);
        assertEq(router.quote(address(usdg), address(tsla), 1000e6), cleanQuote);
    }

    function test_SkewIsIsolatedToTheDirectedPair() public {
        uint256 reverse = router.quote(address(tsla), address(usdg), 1e18);
        uint256 otherMarket = router.quote(address(usdg), address(nvda), 1000e6);
        router.setSkew(address(usdg), address(tsla), 500);
        assertEq(router.quote(address(tsla), address(usdg), 1e18), reverse);
        assertEq(router.quote(address(usdg), address(nvda), 1000e6), otherMarket);
        assertEq(router.skewBps(address(tsla), address(usdg)), 0);
    }

    function test_FeePlusSkewCannotExceedFullNotional() public {
        router.setSkew(address(usdg), address(tsla), 9980);
        assertEq(router.quote(address(usdg), address(tsla), 1000e6), 0);
        vm.expectRevert(DemoRouter.SkewTooHigh.selector);
        router.setSkew(address(usdg), address(tsla), 9981);
        assertEq(router.skewBps(address(usdg), address(tsla)), 9980);
        DemoRouter maximumFee = new DemoRouter(oracle, 1000);
        maximumFee.setSkew(address(usdg), address(tsla), 9000);
        assertEq(maximumFee.quote(address(usdg), address(tsla), 1000e6), 0);
        vm.expectRevert(DemoRouter.SkewTooHigh.selector);
        maximumFee.setSkew(address(usdg), address(tsla), 9001);
    }
}
