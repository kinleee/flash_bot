/**
 * ====================================================
 * FLASH LOAN ARBITRAGE BOT - Base Chain
 * ====================================================
 * 
 * Bu bot:
 * 1. Uniswap V3 və SushiSwap V2-dəki qiymət fərqlərini izləyir
 * 2. Gəlirli fürsət tapanda flash loan arbitraj icra edir
 * 3. Hər testin nəticəsini loglaşdırır (optimizasiya üçün)
 * 
 * QURAŞDIRMA:
 *   npm init -y
 *   npm install ethers@6 dotenv
 * 
 * İSTİFADƏ:
 *   node bot.js                    # Normal rejim
 *   node bot.js --dry-run          # Simulyasiya (real əməliyyat göndərmir)
 *   node bot.js --min-profit 0.5   # Minimum profit (USD)
 */

const { ethers } = require('ethers');
require('dotenv').config();

// ============ CONFIG ============
const CONFIG = {
    // Base chain RPC (pulsuz public RPC, daha sürətli istəsən Alchemy/Infura işlət)
    RPC_URL: process.env.RPC_URL || 'https://mainnet.base.org',
    
    // Sənin deploy etdiyin FlashArbBot contract ünvanı
    ARB_CONTRACT: process.env.ARB_CONTRACT || '0xYOUR_CONTRACT_ADDRESS_HERE',
    
    // Cüzdan private key (.env faylında saxla!)
    PRIVATE_KEY: process.env.PRIVATE_KEY || '',
    
    // Flash loan ilə borc alınacaq məbləğ (WETH-də)
    // Daha böyük = daha çox potensial qazanc, amma daha çox slippage riski
    BORROW_AMOUNTS: [
        ethers.parseEther('0.1'),   // 0.1 ETH (~$200)
        ethers.parseEther('0.5'),   // 0.5 ETH (~$1000)
        ethers.parseEther('1.0'),   // 1.0 ETH (~$2000)
        ethers.parseEther('5.0'),   // 5.0 ETH (~$10000)
    ],

    // Minimum profit threshold (wei cinsindən)
    MIN_PROFIT_WEI: ethers.parseEther('0.0005'), // ~$1
    
    // Yoxlanış intervalı (ms)
    CHECK_INTERVAL: 3000, // hər 3 saniyə
    
    // Gas limit
    GAS_LIMIT: 500000,
    
    // UniV3 fee tiers to check
    UNI_V3_FEES: [500, 3000, 10000], // 0.05%, 0.3%, 1%
};

// ============ BASE CHAIN TOKEN ADRESLƏRİ ============
const TOKENS = {
    WETH:  '0x4200000000000000000000000000000000000006',
    USDC:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
    DAI:   '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
};

// Arbitraj yoxlanacaq token cütləri
const ARB_PAIRS = [
    { base: 'WETH', target: 'USDC',  name: 'ETH/USDC' },
    { base: 'WETH', target: 'USDbC', name: 'ETH/USDbC' },
    { base: 'WETH', target: 'DAI',   name: 'ETH/DAI' },
    { base: 'USDC', target: 'USDbC', name: 'USDC/USDbC' },
    { base: 'WETH', target: 'cbETH', name: 'ETH/cbETH' },
];

// ============ ABIs ============
const UNIV3_QUOTER_ABI = [
    'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)',
];

const SUSHI_ROUTER_ABI = [
    'function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)',
];

const FLASH_ARB_ABI = [
    'function executeArbitrage(tuple(address tokenBorrow, uint256 borrowAmount, address tokenTarget, bool buyOnV3First, uint24 uniV3Fee) params) external',
    'function getStats() external view returns (uint256 totalProfit, uint256 totalTrades, uint256 failedTrades)',
    'function checkProfitability(address tokenIn, address tokenOut, uint256 amountIn, uint24 uniV3Fee) external view returns (uint256 sushiOut, int256 profitIfBuyV3, int256 profitIfBuySushi)',
];

// ============ CONTRACT ADDRESSES (BASE) ============
const CONTRACTS = {
    UNIV3_QUOTER: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', // Uniswap V3 Quoter V2 on Base
    SUSHI_ROUTER: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891', // SushiSwap V2 Router on Base
};

// ============ LOGGING & STATS ============
const stats = {
    checksPerformed: 0,
    opportunitiesFound: 0,
    tradesExecuted: 0,
    tradesFailed: 0,
    totalProfitWei: 0n,
    startTime: Date.now(),
    results: [], // hər yoxlamanın nəticəsi
};

function log(emoji, msg) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] ${emoji} ${msg}`);
}

// ============ MAIN BOT CLASS ============
class FlashArbBot {
    constructor() {
        this.provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
        this.wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, this.provider);
        this.arbContract = new ethers.Contract(CONFIG.ARB_CONTRACT, FLASH_ARB_ABI, this.wallet);
        this.sushiRouter = new ethers.Contract(CONTRACTS.SUSHI_ROUTER, SUSHI_ROUTER_ABI, this.provider);
        this.quoter = new ethers.Contract(CONTRACTS.UNIV3_QUOTER, UNIV3_QUOTER_ABI, this.provider);
        this.dryRun = process.argv.includes('--dry-run');
    }

    async start() {
        log('🚀', `Flash Arb Bot başladılır... (${this.dryRun ? 'DRY RUN' : 'LIVE'})`);
        log('⛓️', `Şəbəkə: Base Chain`);
        
        const balance = await this.provider.getBalance(this.wallet.address);
        log('💰', `Cüzdan balans: ${ethers.formatEther(balance)} ETH`);
        
        if (balance < ethers.parseEther('0.0001')) {
            log('❌', 'Kifayət qədər ETH yoxdur (0.0001 ETH)');
            return;
        }

        log('🔍', `${ARB_PAIRS.length} token cütü izlənilir...`);
        log('📊', `Yoxlama intervalı: ${CONFIG.CHECK_INTERVAL}ms`);
        log('─'.repeat(60), '');

        // Əsas dövrə
        while (true) {
            try {
                await this.scanForOpportunities();
            } catch (err) {
                log('⚠️', `Scan xətası: ${err.message}`);
            }
            await this.sleep(CONFIG.CHECK_INTERVAL);
        }
    }

    async scanForOpportunities() {
        for (const pair of ARB_PAIRS) {
            for (const borrowAmount of CONFIG.BORROW_AMOUNTS) {
                for (const fee of CONFIG.UNI_V3_FEES) {
                    stats.checksPerformed++;
                    
                    try {
                        const result = await this.checkArbitrage(pair, borrowAmount, fee);
                        
                        if (result.profitable) {
                            stats.opportunitiesFound++;
                            log('💎', `FÜRSƏT TAPILDI! ${pair.name} | Profit: ${result.profitFormatted} | Direction: ${result.direction}`);
                            
                            if (!this.dryRun) {
                                await this.executeArbitrage(result);
                            } else {
                                log('🧪', `[DRY RUN] Əməliyyat simulyasiya edildi - göndərilmir`);
                            }
                        }
                    } catch (err) {
                        // Sessiz keç - çox pair/fee yoxlanır, hamısı işləməyəcək
                    }
                }
            }
        }

        // Periodik status
        if (stats.checksPerformed % 100 === 0) {
            this.printStatus();
        }
    }

    async checkArbitrage(pair, borrowAmount, uniV3Fee) {
        const tokenBase = TOKENS[pair.base];
        const tokenTarget = TOKENS[pair.target];

        // 1. SushiSwap V2-də qiymət al
        const pathForward = [tokenBase, tokenTarget];
        const pathReverse = [tokenTarget, tokenBase];

        let sushiForwardAmounts, sushiReverseAmounts;
        
        try {
            sushiForwardAmounts = await this.sushiRouter.getAmountsOut(borrowAmount, pathForward);
        } catch {
            return { profitable: false };
        }

        const sushiTargetOut = sushiForwardAmounts[1];

        try {
            sushiReverseAmounts = await this.sushiRouter.getAmountsOut(sushiTargetOut, pathReverse);
        } catch {
            return { profitable: false };
        }

        // 2. UniV3-dən qiymət al (staticCall ilə simulyasiya)
        let uniV3TargetOut;
        try {
            uniV3TargetOut = await this.quoter.quoteExactInputSingle.staticCall(
                tokenBase, tokenTarget, uniV3Fee, borrowAmount, 0
            );
        } catch {
            return { profitable: false };
        }

        let uniV3BaseBack;
        try {
            uniV3BaseBack = await this.quoter.quoteExactInputSingle.staticCall(
                tokenTarget, tokenBase, uniV3Fee, sushiTargetOut, 0
            );
        } catch {
            return { profitable: false };
        }

        // 3. Flash loan fee hesabla (0.05%)
        const flashFee = (borrowAmount * 5n) / 10000n;
        const totalOwed = borrowAmount + flashFee;

        // 4. Hər iki istiqaməti yoxla
        // Strategiya A: UniV3-dən al → Sushi-dən sat
        let sushiSellBack;
        try {
            const sushiSellAmounts = await this.sushiRouter.getAmountsOut(uniV3TargetOut, pathReverse);
            sushiSellBack = sushiSellAmounts[1];
        } catch {
            sushiSellBack = 0n;
        }
        const profitA = sushiSellBack > totalOwed ? sushiSellBack - totalOwed : 0n;

        // Strategiya B: Sushi-dən al → UniV3-dən sat
        const profitB = uniV3BaseBack > totalOwed ? uniV3BaseBack - totalOwed : 0n;

        // Ən yaxşı strategiyanı seç
        const bestProfit = profitA > profitB ? profitA : profitB;
        const buyOnV3First = profitA > profitB;
        const profitable = bestProfit > CONFIG.MIN_PROFIT_WEI;

        // Nəticəni logla
        const result = {
            profitable,
            pair,
            borrowAmount,
            uniV3Fee,
            buyOnV3First,
            profit: bestProfit,
            profitFormatted: ethers.formatEther(bestProfit),
            direction: buyOnV3First ? 'Buy UniV3 → Sell Sushi' : 'Buy Sushi → Sell UniV3',
            tokenBase,
            tokenTarget,
            timestamp: Date.now(),
        };

        stats.results.push({
            pair: pair.name,
            profitable,
            profit: result.profitFormatted,
            direction: result.direction,
            borrowAmount: ethers.formatEther(borrowAmount),
            fee: uniV3Fee,
            time: new Date().toISOString(),
        });

        // Son 1000 nəticəni saxla
        if (stats.results.length > 1000) {
            stats.results = stats.results.slice(-500);
        }

        return result;
    }

    async executeArbitrage(opportunity) {
        log('⚡', `Arbitraj icra edilir: ${opportunity.pair.name}...`);

        try {
            const params = {
                tokenBorrow: opportunity.tokenBase,
                borrowAmount: opportunity.borrowAmount,
                tokenTarget: opportunity.tokenTarget,
                buyOnV3First: opportunity.buyOnV3First,
                uniV3Fee: opportunity.uniV3Fee,
            };

            // Gas qiymətini yoxla
            const feeData = await this.provider.getFeeData();
            
            const tx = await this.arbContract.executeArbitrage(params, {
                gasLimit: CONFIG.GAS_LIMIT,
                maxFeePerGas: feeData.maxFeePerGas,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
            });

            log('📤', `TX göndərildi: ${tx.hash}`);
            
            const receipt = await tx.wait();
            
            if (receipt.status === 1) {
                stats.tradesExecuted++;
                stats.totalProfitWei += opportunity.profit;
                log('✅', `UĞURLU! TX: ${tx.hash} | Profit: ${opportunity.profitFormatted} ETH`);
            } else {
                stats.tradesFailed++;
                log('❌', `TX uğursuz: ${tx.hash}`);
            }
        } catch (err) {
            stats.tradesFailed++;
            if (err.message.includes('Arb not profitable')) {
                log('📉', `Qiymət dəyişdi, artıq gəlirli deyil (normal hadisə)`);
            } else {
                log('❌', `Xəta: ${err.message.slice(0, 100)}`);
            }
        }
    }

    printStatus() {
        const runtime = ((Date.now() - stats.startTime) / 1000 / 60).toFixed(1);
        log('─'.repeat(60), '');
        log('📊', `STATUS (${runtime} dəq)`);
        log('🔍', `Yoxlamalar: ${stats.checksPerformed}`);
        log('💎', `Fürsətlər: ${stats.opportunitiesFound}`);
        log('✅', `Uğurlu: ${stats.tradesExecuted}`);
        log('❌', `Uğursuz: ${stats.tradesFailed}`);
        log('💰', `Ümumi profit: ${ethers.formatEther(stats.totalProfitWei)} ETH`);
        log('─'.repeat(60), '');
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============ EXPORTS FOR ANALYSIS ============
// Nəticələri JSON-a saxla (mən optimallaşdırım deyə)
function saveResults() {
    const fs = require('fs');
    const report = {
        stats: {
            ...stats,
            totalProfitWei: stats.totalProfitWei.toString(),
        },
        config: {
            minProfit: CONFIG.MIN_PROFIT_WEI.toString(),
            checkInterval: CONFIG.CHECK_INTERVAL,
            borrowAmounts: CONFIG.BORROW_AMOUNTS.map(a => ethers.formatEther(a)),
        },
        recentResults: stats.results.slice(-100),
    };
    fs.writeFileSync('arb_results.json', JSON.stringify(report, null, 2));
    log('💾', 'Nəticələr arb_results.json-a saxlanıldı');
}

// Ctrl+C handler
process.on('SIGINT', () => {
    log('🛑', 'Bot dayandırılır...');
    saveResults();
    process.exit(0);
});

// Hər 5 dəqiqədə avtomatik saxla
setInterval(saveResults, 5 * 60 * 1000);

// ============ START ============
const bot = new FlashArbBot();
bot.start().catch(err => {
    log('💥', `Fatal error: ${err.message}`);
    saveResults();
    process.exit(1);
});
