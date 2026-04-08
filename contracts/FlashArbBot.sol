// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {FlashLoanSimpleReceiverBase} from "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// ─── V3 Router interface (UniV3 + PancakeSwap V3 eyni interfeys) ───────────
interface IV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut);
}

// ─── Aerodrome V1 (Solidly AMM) Router ────────────────────────────────────
interface IAerodromeRouter {
    struct Route {
        address from;
        address to;
        bool    stable;
        address factory;
    }
    function swapExactTokensForTokens(
        uint256          amountIn,
        uint256          amountOutMin,
        Route[] calldata routes,
        address          to,
        uint256          deadline
    ) external returns (uint256[] memory amounts);
}

/// @title  FlashArbBot v2 — Base Chain
/// @notice Flash loan arbitrage: Aerodrome ↔ Uniswap V3 / PancakeSwap V3
contract FlashArbBot is FlashLoanSimpleReceiverBase {

    address public owner;

    // ── Base Chain Addresses ─────────────────────────────────────────────
    address public constant UNI_V3_ROUTER     = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address public constant PANCAKE_V3_ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;
    address public constant AERO_ROUTER       = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address public constant AERO_FACTORY      = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;

    // ── Stats ────────────────────────────────────────────────────────────
    uint256 public totalProfit;
    uint256 public totalTrades;
    uint256 public failedTrades;

    // ── Arb Parameters ───────────────────────────────────────────────────
    struct ArbParams {
        address tokenBorrow;   // Aave-dən borc alınan token (WETH)
        uint256 borrowAmount;  // Borc miqdarı
        address tokenTarget;   // Arbitraj tokeni (USDC, AERO, vs.)
        bool    buyOnV3First;  // true → V3-dən al, Aerodrome-da sat
        uint24  v3Fee;         // V3 pool fee tier (100/500/2500/3000/10000)
        bool    usePancake;    // true → PancakeSwap, false → Uniswap V3
        bool    stablePool;    // true → Aerodrome stable pool
    }

    // ── Events ───────────────────────────────────────────────────────────
    event ArbitrageExecuted(
        address indexed tokenBorrow,
        address indexed tokenTarget,
        uint256         profit,
        bool            usedPancake
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _addressProvider)
        FlashLoanSimpleReceiverBase(IPoolAddressesProvider(_addressProvider))
    {
        owner = msg.sender;
    }

    // ── Ana giriş nöqtəsi ────────────────────────────────────────────────
    function executeArbitrage(ArbParams calldata params) external onlyOwner {
        POOL.flashLoanSimple(
            address(this),
            params.tokenBorrow,
            params.borrowAmount,
            abi.encode(params),
            0
        );
    }

    // ── Aave callback ────────────────────────────────────────────────────
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL),    "Caller must be Aave Pool");
        require(initiator  == address(this),    "Initiator mismatch");

        ArbParams memory p = abi.decode(params, (ArbParams));
        uint256 amountOwed = amount + premium;
        uint256 finalBalance;

        if (p.buyOnV3First) {
            // V3-dən al → Aerodrome-da sat
            uint256 got = _swapV3(asset, p.tokenTarget, amount, p.v3Fee, p.usePancake);
            finalBalance = _swapAero(p.tokenTarget, asset, got, p.stablePool);
        } else {
            // Aerodrome-dan al → V3-da sat
            uint256 got = _swapAero(asset, p.tokenTarget, amount, p.stablePool);
            finalBalance = _swapV3(p.tokenTarget, asset, got, p.v3Fee, p.usePancake);
        }

        require(finalBalance > amountOwed, "Arb not profitable");

        uint256 profit = finalBalance - amountOwed;
        totalProfit += profit;
        totalTrades++;
        emit ArbitrageExecuted(asset, p.tokenTarget, profit, p.usePancake);

        // Aave-ə geri ödə
        IERC20(asset).approve(address(POOL), amountOwed);
        return true;
    }

    // ── Uniswap V3 / PancakeSwap V3 swap ────────────────────────────────
    function _swapV3(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24  fee,
        bool    usePancake
    ) internal returns (uint256) {
        address router = usePancake ? PANCAKE_V3_ROUTER : UNI_V3_ROUTER;
        IERC20(tokenIn).approve(router, amountIn);
        return IV3Router(router).exactInputSingle(
            IV3Router.ExactInputSingleParams({
                tokenIn:           tokenIn,
                tokenOut:          tokenOut,
                fee:               fee,
                recipient:         address(this),
                deadline:          block.timestamp,
                amountIn:          amountIn,
                amountOutMinimum:  0,
                sqrtPriceLimitX96: 0
            })
        );
    }

    // ── Aerodrome swap ───────────────────────────────────────────────────
    function _swapAero(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bool    stable
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(AERO_ROUTER, amountIn);
        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] = IAerodromeRouter.Route({
            from:    tokenIn,
            to:      tokenOut,
            stable:  stable,
            factory: AERO_FACTORY
        });
        uint256[] memory amounts = IAerodromeRouter(AERO_ROUTER)
            .swapExactTokensForTokens(amountIn, 0, routes, address(this), block.timestamp);
        return amounts[amounts.length - 1];
    }

    // ── Admin ────────────────────────────────────────────────────────────
    function withdrawToken(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "No balance");
        IERC20(token).transfer(owner, bal);
    }

    function withdrawETH() external onlyOwner {
        uint256 bal = address(this).balance;
        require(bal > 0, "No ETH");
        payable(owner).transfer(bal);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }

    function getStats() external view returns (
        uint256 _totalProfit,
        uint256 _totalTrades,
        uint256 _failedTrades
    ) {
        return (totalProfit, totalTrades, failedTrades);
    }

    receive() external payable {}
}
