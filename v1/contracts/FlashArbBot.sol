// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {FlashLoanSimpleReceiverBase} from "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Minimal router interfaces
interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);
}

/// @title FlashArbBot - Base Chain Flash Loan Arbitrage
/// @notice Borrows via Aave V3 flash loan, buys on DEX A, sells on DEX B
/// @dev Designed for Base chain (low gas). Deploy once, call executeArbitrage() from bot script.
contract FlashArbBot is FlashLoanSimpleReceiverBase {
    address public owner;

    // ============ BASE CHAIN ADDRESSES ============
    // Uniswap V3 SwapRouter on Base
    address public constant UNISWAP_V3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    // SushiSwap V2 Router on Base  
    address public constant SUSHI_V2_ROUTER = 0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891;

    // Common Base tokens
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant USDbC = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;

    // Track profitability
    uint256 public totalProfit;
    uint256 public totalTrades;
    uint256 public failedTrades;

    // ============ STRUCTS ============
    struct ArbParams {
        address tokenBorrow;    // Token to flash borrow
        uint256 borrowAmount;   // How much to borrow
        address tokenTarget;    // Token to arb through
        bool buyOnV3First;      // true = buy on UniV3, sell on SushiV2
        uint24 uniV3Fee;        // UniV3 pool fee tier (500, 3000, 10000)
    }

    // ============ EVENTS ============
    event ArbitrageExecuted(
        address indexed tokenBorrow,
        address indexed tokenTarget,
        uint256 borrowAmount,
        uint256 profit,
        bool buyOnV3First
    );
    event ArbitrageFailed(string reason);

    // ============ MODIFIERS ============
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    // ============ CONSTRUCTOR ============
    /// @param _addressProvider Aave V3 PoolAddressesProvider on Base
    constructor(address _addressProvider) 
        FlashLoanSimpleReceiverBase(IPoolAddressesProvider(_addressProvider)) 
    {
        owner = msg.sender;
    }

    // ============ MAIN ENTRY POINT ============
    /// @notice Call this from the bot script to trigger arbitrage
    /// @param params The arbitrage parameters
    function executeArbitrage(ArbParams calldata params) external onlyOwner {
        // Encode params to pass through flash loan callback
        bytes memory data = abi.encode(params);
        
        // Request flash loan from Aave V3
        // Fee is 0.05% on V3 (5 basis points)
        POOL.flashLoanSimple(
            address(this),    // receiver
            params.tokenBorrow,
            params.borrowAmount,
            data,
            0                 // referralCode
        );
    }

    // ============ AAVE CALLBACK ============
    /// @notice Called by Aave after we receive the flash loan
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "Caller must be Aave Pool");
        require(initiator == address(this), "Initiator must be this contract");

        ArbParams memory arbParams = abi.decode(params, (ArbParams));

        // Calculate total amount we need to repay (loan + fee)
        uint256 amountOwed = amount + premium;

        // Execute the arbitrage
        uint256 finalBalance;
        
        if (arbParams.buyOnV3First) {
            // Strategy: Buy target token on Uniswap V3, sell on SushiSwap V2
            uint256 targetReceived = _swapOnUniV3(
                asset, 
                arbParams.tokenTarget, 
                amount, 
                arbParams.uniV3Fee
            );
            finalBalance = _swapOnSushiV2(
                arbParams.tokenTarget, 
                asset, 
                targetReceived
            );
        } else {
            // Strategy: Buy target token on SushiSwap V2, sell on Uniswap V3
            uint256 targetReceived = _swapOnSushiV2(
                asset, 
                arbParams.tokenTarget, 
                amount
            );
            finalBalance = _swapOnUniV3(
                arbParams.tokenTarget, 
                asset, 
                targetReceived, 
                arbParams.uniV3Fee
            );
        }

        // Check profitability
        if (finalBalance > amountOwed) {
            uint256 profit = finalBalance - amountOwed;
            totalProfit += profit;
            totalTrades++;
            
            emit ArbitrageExecuted(
                asset, 
                arbParams.tokenTarget, 
                amount, 
                profit, 
                arbParams.buyOnV3First
            );
        } else {
            failedTrades++;
            // This will revert the entire transaction - no loss except gas
            revert("Arb not profitable");
        }

        // Approve Aave to pull repayment
        IERC20(asset).approve(address(POOL), amountOwed);

        return true;
    }

    // ============ SWAP FUNCTIONS ============
    function _swapOnUniV3(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24 fee
    ) internal returns (uint256 amountOut) {
        IERC20(tokenIn).approve(UNISWAP_V3_ROUTER, amountIn);
        
        IUniswapV3Router.ExactInputSingleParams memory swapParams = IUniswapV3Router
            .ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: 0, // We check profitability after
                sqrtPriceLimitX96: 0
            });

        amountOut = IUniswapV3Router(UNISWAP_V3_ROUTER).exactInputSingle(swapParams);
    }

    function _swapOnSushiV2(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
        IERC20(tokenIn).approve(SUSHI_V2_ROUTER, amountIn);
        
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256[] memory amounts = IUniswapV2Router(SUSHI_V2_ROUTER)
            .swapExactTokensForTokens(
                amountIn,
                0,  // We check profitability after
                path,
                address(this),
                block.timestamp
            );

        amountOut = amounts[amounts.length - 1];
    }

    // ============ VIEW FUNCTIONS ============
    /// @notice Check potential profit without executing
    /// @dev Call this from bot to simulate before executing
    function checkProfitability(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24 uniV3Fee
    ) external view returns (
        uint256 sushiOut,
        int256 profitIfBuyV3,
        int256 profitIfBuySushi
    ) {
        // Check SushiSwap V2 price
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        
        try IUniswapV2Router(SUSHI_V2_ROUTER).getAmountsOut(amountIn, path) returns (uint256[] memory amounts) {
            sushiOut = amounts[1];
        } catch {
            sushiOut = 0;
        }
        
        // Flash loan fee (0.05%)
        uint256 flashFee = (amountIn * 5) / 10000;
        
        // Rough profit estimates (actual may differ due to slippage)
        // profitIfBuyV3: buy on UniV3, sell on Sushi
        // profitIfBuySushi: buy on Sushi, sell on UniV3
        // These are approximations - real execution may differ
        profitIfBuyV3 = 0;  // Need actual UniV3 quote (complex off-chain)
        profitIfBuySushi = 0;
    }

    // ============ ADMIN FUNCTIONS ============
    /// @notice Withdraw any token stuck in contract
    function withdrawToken(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No balance");
        IERC20(token).transfer(owner, balance);
    }

    /// @notice Withdraw ETH stuck in contract
    function withdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No balance");
        payable(owner).transfer(balance);
    }

    /// @notice Transfer ownership
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }

    /// @notice Get contract stats
    function getStats() external view returns (
        uint256 _totalProfit,
        uint256 _totalTrades,
        uint256 _failedTrades
    ) {
        return (totalProfit, totalTrades, failedTrades);
    }

    receive() external payable {}
}
