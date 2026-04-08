/**
 * ====================================================
 * DYNAMIC FLASH LOAN ARBITRAGE BOT - Base Chain
 * ====================================================
 *
 * Arxitektura:
 *   1. TokenDiscovery: Aerodrome factory-dən bütün aktiv pool-ları tapır
 *      → TVL filtrə → Uniswap V3-də cross-check → Watchlist
 *   2. WebSocket: Swap event-lərini real-time dinləyir
 *   3. Paralel RPC: Event gəldikdə eyni anda hər iki DEX-i yoxlayır
 *   4. Scorer: Tarixə əsasən yüksək-fürsət cütlərə prioritet verir
 *   5. Rediscovery: Hər 15 dəqiqədə yeni pool-lar axtarır
 *
 * İSTİFADƏ:
 *   node bot.js             # Live rejim
 *   node bot.js --dry-run   # Simulyasiya
 */

const { ethers } = require('ethers');
require('dotenv').config();

// ============ CONFIG ============
const CONFIG = {
    RPC_URL:      process.env.RPC_URL,
    WS_URL:       process.env.WS_URL,
    ARB_CONTRACT: process.env.ARB_CONTRACT,
    PRIVATE_KEY:  process.env.PRIVATE_KEY,

    MIN_PROFIT_WEI:    ethers.parseEther('0.00005'), // ~$0.10
    MIN_RESERVE_ETH:   ethers.parseEther('0.05'),   // WETH-li pool: min 0.05 ETH (daha çox volatil cüt)
    MIN_RESERVE_USDC:  100_000n,                    // USDC-li pool: min $0.1 (6 decimal)
    GAS_LIMIT:         500000,
    UNI_V3_FEES:       [100, 500, 3000, 10000],
    PANCAKE_V3_FEES:   [100, 500, 2500, 10000],     // PancakeSwap V3 fee tiers

    BORROW_AMOUNTS: [
        ethers.parseEther('0.05'),
        ethers.parseEther('0.1'),
        ethers.parseEther('0.5'),
        ethers.parseEther('1.0'),
    ],

    MAX_PAIRS:          500,    // maksimum izlənəcək cüt sayı
    DISCOVERY_BATCH_SIZE: 50,   // eyni anda neçə cüt yoxlansın
    SCORE_DECAY:        0.95,   // saatda score azalması
    REDISCOVER_MS:      15 * 60_000, // hər 15 dəqiqədə yenidən kəşf
    DEBOUNCE_MS:        300,    // eyni cüt üçün debounce (sürətli reaksiya)
    BACKUP_SCAN_MS:     10_000, // backup periodik scan (10 san)
    HOT_SCAN_MS:        1_000,  // top 3 cüt üçün sürətli scan (1 san)
};

// ============ ADDRESSES (Base Mainnet) ============
const ADDR = {
    WETH:  '0x4200000000000000000000000000000000000006',
    USDC:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    AERO:  '0x940181a94A35A4569E4529A3CDfB74e38FD98631',

    UNIV3_FACTORY: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    UNIV3_QUOTER:  '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',

    // Aerodrome Finance — Base-in #1 DEX-i (TVL $500M+)
    AERO_FACTORY:  '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
    AERO_ROUTER:   '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',

    // PancakeSwap V3 — Base-də ikinci böyük concentrated liquidity DEX
    PANCAKE_FACTORY: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    PANCAKE_QUOTER:  '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
};

// ============ ABIs ============
const ABI = {
    UNI_FACTORY: [
        'function getPool(address,address,uint24) external view returns (address)',
        'event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)',
    ],
    UNI_POOL: [
        'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
    ],
    UNI_QUOTER: [
        'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
        'function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
    ],
    // PancakeSwap V3 — UniV3 ilə eyni interfeys
    PANCAKE_FACTORY: [
        'function getPool(address,address,uint24) external view returns (address)',
        'event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)',
    ],
    PANCAKE_QUOTER: [
        'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
        'function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
    ],

    AERO_FACTORY: [
        'function allPools(uint256) external view returns (address)',
        'function allPoolsLength() external view returns (uint256)',
        'function getPool(address,address,bool) external view returns (address)',
        'event PoolCreated(address indexed token0,address indexed token1,bool indexed stable,address pool,uint256)',
    ],
    AERO_PAIR: [
        'function token0() external view returns (address)',
        'function token1() external view returns (address)',
        'function stable() external view returns (bool)',
        'function getReserves() external view returns (uint256,uint256,uint256)',
        'event Swap(address indexed sender,address indexed to,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out)',
    ],
    AERO_ROUTER: [
        'function getAmountsOut(uint256 amountIn, tuple(address from,address to,bool stable,address factory)[] routes) external view returns (uint256[] memory)',
    ],

    FLASH_ARB: [
        'function executeArbitrage(tuple(address tokenBorrow,uint256 borrowAmount,address tokenTarget,bool buyOnV3First,uint24 v3Fee,bool usePancake,bool stablePool) params) external',
        'function getStats() external view returns (uint256 totalProfit,uint256 totalTrades,uint256 failedTrades)',
    ],
};

// ============ POOL SCORER ============
class PoolScorer {
    constructor() {
        this.scores   = new Map();
        this.lastDecay = Date.now();
    }
    key(t0, t1)        { return [t0, t1].sort().join('-').toLowerCase(); }
    record(t0, t1, wei){ const k = this.key(t0,t1); this.scores.set(k, (this.scores.get(k)||0) + parseFloat(ethers.formatEther(wei))*100 + 1); }
    get(t0, t1)        { return this.scores.get(this.key(t0,t1)) || 0; }
    top(n=20)          { return [...this.scores.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n); }
    decay() {
        if (Date.now() - this.lastDecay < 3_600_000) return;
        for (const [k,v] of this.scores) this.scores.set(k, v * CONFIG.SCORE_DECAY);
        this.lastDecay = Date.now();
    }
}

// ============ TOKEN DISCOVERY ============
// Məlum likvid tokenlərdən birbaşa soruşur:
//   aeroFactory.getPool(tA, tB, false) → pool var/yox
//   uniFactory.getPool(tA, tB, fee)   → cross-check
// 22K pool iterate etmək əvəzinə, hədəfli sorğu ilə 10x sürətli
class TokenDiscovery {
    constructor(provider, uniFactory, pancakeFactory, aeroFactory) {
        this.provider       = provider;
        this.uniFactory     = uniFactory;
        this.pancakeFactory = pancakeFactory;
        this.aeroFactory    = aeroFactory;

        // Əsas sabit tokenlar — həmişə yoxlanılır (ən likvid)
        this.coreTokens = [
            '0x4200000000000000000000000000000000000006', // WETH
            '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
            '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', // USDbC
            '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
            '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', // cbETH
            '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC
            '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', // wstETH
            '0xB6fe221Fe9EEF5aBa221c348bA20A1Bf5e73624c', // rETH
            '0x940181a94A35A4569E4529A3CDfB74e38FD98631', // AERO
            // Base memecoin + ecosystem tokens (Aerodrome+V3 hər ikisində mövcud)
            '0x532f27101965dd16442E59d40670FaF5eBB142E4', // BRETT
            '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', // DEGEN
            '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4', // TOSHI
            '0xA88594D404727625A9437C3f886C7643872296AE', // WELL
            '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', // EURC
        ];
        // Dinamik genişlənən siyahı — başlanğıcda core ilə eyni
        this.seedTokens = [...this.coreTokens];
    }

    // ── DİNAMİK SEED GENİŞLƏNMƏSİ ─────────────────────────
    // DexScreener-dən Base-in ən likvid tokenlarını kəşf edir.
    // 3 hub token (WETH, USDC, AERO) sorğulanır → geniş token bazası.
    // Pulsuz, API key yox, RPC yükü yox.
    async expandSeeds() {
        const known  = new Set(this.seedTokens.map(t => t.toLowerCase()));
        const MIN_LIQ = 10_000;  // minimum $10K liquidity (aşağı salındı)
        const MAX_NEW = 200;     // maksimum yeni token sayı (artırıldı)

        // Hub tokenlar — bunların cütlərindən yeni tokenlar çıxarılır
        // Nə qədər çox hub, bir o qədər çox token kəşf edilir
        const HUBS = [
            ADDR.WETH,
            ADDR.USDC,
            ADDR.AERO,
            '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', // cbETH
            '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC
            '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', // wstETH
        ];

        const allPairs = [];

        for (const hub of HUBS) {
            try {
                const url  = `https://api.dexscreener.com/latest/dex/tokens/${hub}`;
                const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
                if (!resp.ok) continue;
                const data = await resp.json();

                const pairs = (data.pairs || []).filter(p =>
                    p.chainId === 'base' && (p.liquidity?.usd ?? 0) >= MIN_LIQ
                );
                allPairs.push(...pairs);
            } catch { /* network xətası, skip */ }
        }

        // Likvidsiyəyə görə sırala, dublikatları aradan qaldır
        allPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

        let added = 0;
        const seen = new Set();

        for (const pair of allPairs) {
            if (added >= MAX_NEW) break;

            const t0 = pair.baseToken?.address?.toLowerCase();
            const t1 = pair.quoteToken?.address?.toLowerCase();
            if (!t0 || !t1) continue;

            // Hər iki tokeni nəzərdən keçir — hub deyilsə əlavə et
            for (const addr of [pair.baseToken.address, pair.quoteToken.address]) {
                const low = addr.toLowerCase();
                if (known.has(low) || seen.has(low)) continue;
                seen.add(low);
                known.add(low);
                this.seedTokens.push(addr);
                added++;
            }
        }

        const totalSeeds = this.seedTokens.length;
        log('🌱', `DexScreener (${HUBS.length} hub): ${allPairs.length} cüt → +${added} yeni token | Cəmi seed: ${totalSeeds}`);
        return added;
    }

    async discoverPairs() {
        log('🔭', `Seed tokenlərdən cüt kəşfiyyatı (${this.seedTokens.length} token → ${this._pairCount()} mümkün cüt)...`);

        // Bütün token cütlərini yarat
        const pairs = [];
        for (let i = 0; i < this.seedTokens.length; i++)
            for (let j = i + 1; j < this.seedTokens.length; j++)
                pairs.push([this.seedTokens[i], this.seedTokens[j]]);

        // Batch-lərlə yoxla
        const crossDex = [];
        for (let i = 0; i < pairs.length; i += CONFIG.DISCOVERY_BATCH_SIZE) {
            const batch = pairs.slice(i, i + CONFIG.DISCOVERY_BATCH_SIZE);
            await Promise.allSettled(batch.map(async ([t0, t1]) => {
                const result = await this._checkPair(t0, t1);
                if (result) crossDex.push(result);
            }));
        }

        log('✅', `${crossDex.length} aktiv cüt tapıldı (hər iki DEX-də mövcud + TVL OK)`);
        return crossDex;
    }

    _pairCount() {
        const n = this.seedTokens.length;
        return (n * (n - 1)) / 2;
    }

    async _checkPair(t0, t1) {
        try {
            // Həm volatile (false) həm stable (true) pool-u yoxla
            const [volatileAddr, stableAddr] = await Promise.all([
                this.aeroFactory.getPool(t0, t1, false).catch(() => ethers.ZeroAddress),
                this.aeroFactory.getPool(t0, t1, true).catch(() => ethers.ZeroAddress),
            ]);

            // Ən likvid pool-u seç
            let aeroPair   = null;
            let isStable   = false;
            let aeroToken0 = null;
            let bestReserve = 0n;

            for (const [addr, stable] of [[volatileAddr, false], [stableAddr, true]]) {
                if (!addr || addr === ethers.ZeroAddress) continue;
                try {
                    const pc = new ethers.Contract(addr, ABI.AERO_PAIR, this.provider);
                    const [res, poolTok0] = await Promise.all([pc.getReserves(), pc.token0()]);
                    // Pool-un əsl token0-ına görə WETH rezervini tap
                    const wethIsPoolTok0 = poolTok0.toLowerCase() === ADDR.WETH.toLowerCase();
                    const wethRes = wethIsPoolTok0 ? res[0] : res[1];
                    if (wethRes < CONFIG.MIN_RESERVE_ETH) continue;
                    if (wethRes > bestReserve) {
                        bestReserve = wethRes;
                        aeroPair    = addr;
                        isStable    = stable;
                        aeroToken0  = poolTok0; // pool-un əsl token0 ünvanı
                    }
                } catch {}
            }

            if (!aeroPair) return null;

            // UniV3 + PancakeSwap V3-də eyni cüt varmı?
            const v3Pools = await this._findV3Pools(t0, t1);
            if (v3Pools.length === 0) return null;

            return { token0: t0, token1: t1, aeroPair, isStable, aeroToken0, v3Pools };
        } catch {
            return null;
        }
    }

    _hasSufficientLiquidity(t0, t1, reserves) {
        const r0 = reserves[0];
        const r1 = reserves[1];
        const weth = ADDR.WETH.toLowerCase();
        const usdc = ADDR.USDC.toLowerCase();

        if (t0.toLowerCase() === weth || t1.toLowerCase() === weth) {
            // WETH cütü: reserve WETH-in miqdarına bax
            const wethReserve = t0.toLowerCase() === weth ? r0 : r1;
            return wethReserve >= CONFIG.MIN_RESERVE_ETH;
        }
        if (t0.toLowerCase() === usdc || t1.toLowerCase() === usdc) {
            // USDC cütü: 6 decimal, min $1000
            const usdcReserve = t0.toLowerCase() === usdc ? r0 : r1;
            return usdcReserve >= CONFIG.MIN_RESERVE_USDC;
        }
        // Digər cütlər: hər hansı reserve kifayət qədər böyükdürsə qəbul et
        return r0 > 0n && r1 > 0n;
    }

    // Həm UniV3 həm PancakeSwap V3 pool-larını tap
    async _findV3Pools(t0, t1) {
        const UNI_POOL_LIQ = ['function liquidity() external view returns (uint128)'];

        const [uniResults, pancakeResults] = await Promise.all([
            Promise.allSettled(CONFIG.UNI_V3_FEES.map(fee => this.uniFactory.getPool(t0, t1, fee))),
            Promise.allSettled(CONFIG.PANCAKE_V3_FEES.map(fee => this.pancakeFactory.getPool(t0, t1, fee))),
        ]);

        const candidates = [
            ...uniResults
                .map((r, i) => ({ result: r, fee: CONFIG.UNI_V3_FEES[i], dex: 'uni' }))
                .filter(({ result }) => result.status === 'fulfilled' && result.value !== ethers.ZeroAddress)
                .map(({ result, fee, dex }) => ({ address: result.value, fee, dex })),
            ...pancakeResults
                .map((r, i) => ({ result: r, fee: CONFIG.PANCAKE_V3_FEES[i], dex: 'pancake' }))
                .filter(({ result }) => result.status === 'fulfilled' && result.value !== ethers.ZeroAddress)
                .map(({ result, fee, dex }) => ({ address: result.value, fee, dex })),
        ];

        // Eyni address-i deduplicate et (uni+pancake bəzən eyni pool paylaşa bilər)
        const seen = new Set();
        const unique = candidates.filter(p => {
            const k = `${p.address}-${p.dex}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });

        // Likvidsiz pool-ları filtrələ
        const liquid = [];
        for (const pool of unique) {
            try {
                const c = new ethers.Contract(pool.address, UNI_POOL_LIQ, this.provider);
                const liq = await c.liquidity();
                if (liq > 0n) liquid.push(pool);
            } catch {}
        }
        return liquid;
    }

    // Köhnə ad — geriyə uyğunluq üçün saxlanır
    async _findUniPools(t0, t1) { return this._findV3Pools(t0, t1); }
}

// ============ LOGGING ============
function log(emoji, msg) {
    console.log(`[${new Date().toISOString().slice(11,19)}] ${emoji} ${msg}`);
}

// ============ MAIN BOT ============
class DynamicArbBot {
    constructor() {
        this.provider    = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
        this.wsProvider  = new ethers.WebSocketProvider(CONFIG.WS_URL);
        this.wallet      = new ethers.Wallet(CONFIG.PRIVATE_KEY, this.provider);

        this.quoter         = new ethers.Contract(ADDR.UNIV3_QUOTER,    ABI.UNI_QUOTER,     this.provider);
        this.pancakeQuoter  = new ethers.Contract(ADDR.PANCAKE_QUOTER,  ABI.PANCAKE_QUOTER, this.provider);
        this.uniFactory     = new ethers.Contract(ADDR.UNIV3_FACTORY,   ABI.UNI_FACTORY,    this.provider);
        this.pancakeFactory = new ethers.Contract(ADDR.PANCAKE_FACTORY, ABI.PANCAKE_FACTORY,this.provider);
        this.aeroFactory    = new ethers.Contract(ADDR.AERO_FACTORY,    ABI.AERO_FACTORY,   this.provider);
        this.arbExec        = new ethers.Contract(CONFIG.ARB_CONTRACT,  ABI.FLASH_ARB,      this.wallet);

        this.discovery   = new TokenDiscovery(this.provider, this.uniFactory, this.pancakeFactory, this.aeroFactory);
        this.scorer      = new PoolScorer();
        this.pairs       = new Map();   // key → { token0, token1, aeroPair, v3Pools[] }
        this.debounce    = new Set();
        this.dryRun      = process.argv.includes('--dry-run');
        this.debug       = process.argv.includes('--debug');
        this.executing   = false; // eyni anda yalnız 1 TX göndər

        this.stats = {
            events: 0, checks: 0, found: 0,
            executed: 0, failed: 0,
            profitWei: 0n,
            start: Date.now(),
        };
    }

    // ── BAŞLANĞIC ─────────────────────────────────────────
    async start() {
        log('🚀', `Dynamic Arb Bot (${this.dryRun ? 'DRY RUN' : 'LIVE'})`);
        log('⛓️',  'Şəbəkə: Base Chain | DEX-lər: Uniswap V3 ↔ Aerodrome');

        const bal = await this.provider.getBalance(this.wallet.address);
        log('💰', `Cüzdan balansı: ${ethers.formatEther(bal)} ETH (yalnız gas üçün lazımdır)`);
        log('ℹ️',  'Flash loan: kapital tələb etmir — borca alıb, arbitraj edib, qaytarırıq');
        if (bal < ethers.parseEther('0.00005')) {
            log('⚠️', 'Gas fee üçün kifayət qədər ETH yoxdur (~0.00005 ETH lazımdır)');
            if (!this.dryRun) return;
        }

        // İlk dinamik seed genişlənməsi, sonra kəşf
        await this._expandAndDiscover();

        // Factory event-ləri: yeni pool yarananda avtomatik əlavə et
        this._subscribeFactories();

        // Hər 30 dəqiqədə dinamik seed yenilənməsi + kəşf
        setInterval(() => this._expandAndDiscover(), 30 * 60_000);
        // Hər 15 dəqiqədə yalnız kəşf (seed dəyişmədən)
        setInterval(() => this._runDiscovery(), CONFIG.REDISCOVER_MS);

        // Backup scan (yüksək skorlu cütlər)
        this._startBackupScan();

        // HOT SCAN: top cütlər hər 1 saniyədə yoxlanılır (event gəlmədən)
        this._startHotScan();

        // Üçbucaq arbitraj scanner
        setTimeout(() => this._scanTriangles(), 5_000);
        setInterval(() => this._scanTriangles(), 2 * 60_000);

        // Status printer
        setInterval(() => this._printStatus(), 60_000);

        log('✅', `Bot hazırdır — ${this.pairs.size} cüt izlənilir`);
    }

    // ── SEED GENİŞLƏNMƏSİ + KƏŞF ────────────────────────
    async _expandAndDiscover() {
        log('🌱', 'Dinamik seed genişlənməsi başlayır...');
        try {
            await this.discovery.expandSeeds();
        } catch (e) {
            log('⚠️', `Seed genişlənmə xətası: ${e.message.slice(0, 60)}`);
        }
        await this._runDiscovery();
    }

    // ── DİNAMİK KƏŞFİYYAT ────────────────────────────────
    async _runDiscovery() {
        log('🔭', 'Token kəşfiyyatı başlayır...');
        try {
            const discovered = await this.discovery.discoverPairs();
            let added = 0;

            for (const p of discovered) {
                const key = [p.token0, p.token1].sort().join('-').toLowerCase();
                if (this.pairs.has(key) || this.pairs.size >= CONFIG.MAX_PAIRS) continue;

                this.pairs.set(key, p);
                this._subscribePoolEvents(p);
                added++;
            }

            if (added > 0) log('➕', `${added} yeni cüt əlavə edildi (cəmi: ${this.pairs.size})`);
            else           log('📊', `Yeni cüt yoxdur (cəmi: ${this.pairs.size})`);
        } catch (err) {
            log('⚠️', `Kəşfiyyat xətası: ${err.message}`);
            log('🔄', '30 saniyə sonra yenidən cəhd ediləcək...');
            setTimeout(() => this._runDiscovery(), 30_000);
        }
    }

    // ── FACTORY EVENTS: YENİ POOL-LAR ANINDA ─────────────
    _subscribeFactories() {
        const uniWs     = new ethers.Contract(ADDR.UNIV3_FACTORY,   ABI.UNI_FACTORY,     this.wsProvider);
        const pancakeWs = new ethers.Contract(ADDR.PANCAKE_FACTORY, ABI.PANCAKE_FACTORY, this.wsProvider);
        const aeroWs    = new ethers.Contract(ADDR.AERO_FACTORY,    ABI.AERO_FACTORY,    this.wsProvider);

        const _onNewV3Pool = async (t0, t1) => {
            const [volatileAddr, stableAddr] = await Promise.all([
                this.aeroFactory.getPool(t0, t1, false).catch(() => ethers.ZeroAddress),
                this.aeroFactory.getPool(t0, t1, true).catch(() => ethers.ZeroAddress),
            ]);
            const aeroPair = volatileAddr !== ethers.ZeroAddress ? volatileAddr : stableAddr;
            const isStable = volatileAddr === ethers.ZeroAddress && stableAddr !== ethers.ZeroAddress;
            if (aeroPair === ethers.ZeroAddress) return;

            const v3Pools = await this.discovery._findV3Pools(t0, t1);
            const key = [t0, t1].sort().join('-').toLowerCase();
            if (!this.pairs.has(key) && v3Pools.length > 0) {
                const p = { token0: t0, token1: t1, aeroPair, isStable, aeroToken0: null, v3Pools };
                this.pairs.set(key, p);
                this._subscribePoolEvents(p);
                log('🆕', `Yeni cüt — ${t0.slice(0,8)}…/${t1.slice(0,8)}… (${isStable?'stable':'vol'}, ${v3Pools.length} V3 pool)`);
            }
        };

        uniWs.on('PoolCreated',     (t0, t1) => _onNewV3Pool(t0, t1));
        pancakeWs.on('PoolCreated', (t0, t1) => _onNewV3Pool(t0, t1));

        aeroWs.on('PoolCreated', async (t0, t1, stable, pair) => {
            const v3Pools = await this.discovery._findV3Pools(t0, t1);
            if (v3Pools.length === 0) return;
            const key = [t0, t1].sort().join('-').toLowerCase();
            if (!this.pairs.has(key)) {
                const p = { token0: t0, token1: t1, aeroPair: pair, isStable: stable, aeroToken0: null, v3Pools };
                this.pairs.set(key, p);
                this._subscribePoolEvents(p);
                log('🆕', `Yeni Aerodrome ${stable?'stable':'vol'} cüt — ${t0.slice(0,8)}…/${t1.slice(0,8)}…`);
            }
        });
    }

    // ── SWAP EVENT SUBSCRIBE ─────────────────────────────
    _subscribePoolEvents({ token0, token1, aeroPair, v3Pools }) {
        const trigger = () => { this.stats.events++; this._triggerCheck(token0, token1); };

        // Aerodrome swap
        new ethers.Contract(aeroPair, ABI.AERO_PAIR, this.wsProvider).on('Swap', trigger);

        // UniV3 + PancakeSwap swap-ları
        for (const pool of v3Pools) {
            new ethers.Contract(pool.address, ABI.UNI_POOL, this.wsProvider).on('Swap', trigger);
        }
    }

    // ── DEBOUNCE ─────────────────────────────────────────
    _triggerCheck(t0, t1) {
        const key = [t0, t1].sort().join('-');
        if (this.debounce.has(key)) return;
        this.debounce.add(key);
        setTimeout(() => this.debounce.delete(key), CONFIG.DEBOUNCE_MS);
        this._checkAndExecute(t0, t1).catch(() => {});
    }

    // ── ARBİTRAJ YOXLAMA ─────────────────────────────────
    async _checkAndExecute(t0, t1) {
        this.stats.checks++;
        const pairInfo = this.pairs.get([t0, t1].sort().join('-').toLowerCase());
        if (!pairInfo) return;

        const _weth = ADDR.WETH.toLowerCase();
        const _usdc = ADDR.USDC.toLowerCase();
        const hasWeth = t0.toLowerCase() === _weth || t1.toLowerCase() === _weth;
        const hasUsdc = t0.toLowerCase() === _usdc || t1.toLowerCase() === _usdc;
        // Yalnız WETH olmayan USDC cütlərində USDC miqdarı istifadə et (məs. USDC/AERO)
        const isUsdcOnlyPair = hasUsdc && !hasWeth;

        // USDC-only cütlər üçün miqdarı 6 decimal-a uyğunlaşdır (~$500, $1000, $5000, $10000)
        const borrowAmounts = isUsdcOnlyPair
            ? [500_000_000n, 1_000_000_000n, 5_000_000_000n, 10_000_000_000n]
            : CONFIG.BORROW_AMOUNTS;

        for (const amount of borrowAmounts) {
            // Bütün V3 pool-larını (UniV3 + PancakeSwap) yoxla
            for (const v3Pool of [...(pairInfo.v3Pools || [])]) {
                try {
                    const result = await this._checkArb(pairInfo, amount, v3Pool);
                    if (!result.profitable) continue;

                    this.stats.found++;
                    this.scorer.record(t0, t1, result.profit);
                    log('💎', `FÜRSƏT! ${t0.slice(0,8)}…/${t1.slice(0,8)}… [${result.dex}] fee:${v3Pool.fee} | ${result.profitFormatted}`);

                    if (this.dryRun) {
                        log('🧪', `[DRY RUN] Simulyasiya — real tx göndərilmədi`);
                    } else {
                        await this._execute(result);
                    }

                    return; // Bu amount üçün fürsət tapıldı, növbəti pool-u skip et
                } catch {}
            }
        }
    }

    // WETH/USDC borrow token, v3Pool = {fee, dex:'uni'|'pancake', address}
    async _checkArb(pairInfo, borrowAmount, v3Pool) {
        const { token0, token1, aeroPair, isStable, aeroToken0 } = pairInfo;
        const { fee: v3Fee, dex } = v3Pool;
        const weth = ADDR.WETH.toLowerCase();
        const usdc = ADDR.USDC.toLowerCase();

        // Borrow token: WETH > USDC > digər (Aave-dən borc almaq mümkün)
        let tokenBase, tokenTarget;
        if (token0.toLowerCase() === weth || token1.toLowerCase() === weth) {
            tokenBase   = token0.toLowerCase() === weth ? token0 : token1;
            tokenTarget = token0.toLowerCase() === weth ? token1 : token0;
        } else if (token0.toLowerCase() === usdc || token1.toLowerCase() === usdc) {
            tokenBase   = token0.toLowerCase() === usdc ? token0 : token1;
            tokenTarget = token0.toLowerCase() === usdc ? token1 : token0;
        } else {
            return { profitable: false };
        }

        // Aerodrome reserves
        const aeroCon = new ethers.Contract(aeroPair, ABI.AERO_PAIR, this.provider);
        const reserves = await aeroCon.getReserves().catch(() => null);
        if (!reserves) return { profitable: false };

        // Pool-un əsl token0-ına görə tokenBase hansı reserve-dədir
        const poolToken0 = (aeroToken0 || token0).toLowerCase();
        const baseIsToken0 = poolToken0 === tokenBase.toLowerCase();
        const [rBase, rTarget] = baseIsToken0
            ? [reserves[0], reserves[1]]
            : [reserves[1], reserves[0]];
        if (rBase === 0n || rTarget === 0n) return { profitable: false };

        // Token decimal-larını tap (stable pool üçün normalizasiya lazımdır)
        let dec0 = 18n, dec1 = 18n;
        if (isStable) {
            const erc20 = ['function decimals() view returns (uint8)'];
            [dec0, dec1] = await Promise.all([
                new ethers.Contract(tokenBase,   erc20, this.provider).decimals().then(BigInt).catch(()=>18n),
                new ethers.Contract(tokenTarget, erc20, this.provider).decimals().then(BigInt).catch(()=>18n),
            ]);
        }

        // Aerodrome AMM qiyməti
        const aeroFwdOut = isStable
            ? this._stableAmmOut(borrowAmount, rBase, rTarget, dec0, dec1)
            : this._ammOut(borrowAmount, rBase, rTarget);

        // V3 quoter-i seç (UniV3 vs PancakeSwap)
        const quoter = dex === 'pancake' ? this.pancakeQuoter : this.quoter;

        // Forward quote — uğursuz olsa bu pool-u siyahıdan çıxar
        const v3FwdRaw = await quoter.quoteExactInputSingle.staticCall(
            [tokenBase, tokenTarget, borrowAmount, v3Fee, 0]
        ).catch(() => {
            // Bu fee-dəki pool işlənmir — gələcəkdə yenidən cəhd etmə
            if (pairInfo.v3Pools) {
                pairInfo.v3Pools = pairInfo.v3Pools.filter(
                    p => !(p.fee === v3Fee && p.dex === dex)
                );
            }
            return null;
        });

        // Reverse quote (yalnız forward uğurlu olsa)
        const v3BackRaw = v3FwdRaw
            ? await quoter.quoteExactInputSingle.staticCall(
                [tokenTarget, tokenBase, aeroFwdOut, v3Fee, 0]
              ).catch(() => null)
            : null;

        if (!v3FwdRaw) return { profitable: false };
        const v3FwdOut  = Array.isArray(v3FwdRaw)  ? v3FwdRaw[0]  : v3FwdRaw;
        const v3BackOut = v3BackRaw ? (Array.isArray(v3BackRaw) ? v3BackRaw[0] : v3BackRaw) : null;

        // Aero reverse on v3 forward
        const aeroBackOut = isStable
            ? this._stableAmmOut(v3FwdOut, rTarget, rBase, dec1, dec0)
            : this._ammOut(v3FwdOut, rTarget, rBase);

        const flashFee  = (borrowAmount * 5n) / 10000n;
        const totalOwed = borrowAmount + flashFee;

        // A: V3-dən al → Aerodrome-da sat
        const profitA = aeroBackOut > totalOwed ? aeroBackOut - totalOwed : 0n;
        // B: Aerodrome-dan al → V3-da sat
        const profitB = v3BackOut && v3BackOut > totalOwed ? v3BackOut - totalOwed : 0n;

        const MAX_REALISTIC_PROFIT = borrowAmount * 2n;
        if (profitA > MAX_REALISTIC_PROFIT || profitB > MAX_REALISTIC_PROFIT) {
            if (this.debug) log('⚠️', `Saxta profit: ${tokenBase.slice(0,8)}/…${tokenTarget.slice(-6)} [${dex}:${v3Fee}] A=${ethers.formatEther(profitA)} B=${v3BackOut?ethers.formatEther(v3BackOut-totalOwed):'n/a'}`);
            return { profitable: false };
        }

        const profit       = profitA > profitB ? profitA : profitB;
        const buyOnV3First = profitA >= profitB;

        // USDC 6 decimal, WETH 18 decimal
        const isUsdcBase = tokenBase.toLowerCase() === ADDR.USDC.toLowerCase();
        const minProfit = isUsdcBase ? 50_000n : CONFIG.MIN_PROFIT_WEI; // USDC: min $0.05

        if (this.debug) {
            const netA = aeroBackOut - totalOwed;
            const netB = v3BackOut ? v3BackOut - totalOwed : -totalOwed;
            const best = netA > netB ? netA : netB;
            const sign = best >= 0n ? '+' : '';
            const netStr = isUsdcBase
                ? `${sign}${(Number(best) / 1e6).toFixed(4)} USDC`
                : `${sign}${ethers.formatEther(best)} ETH`;
            log('📐', `${tokenBase.slice(0,8)}/…${tokenTarget.slice(-4)} [${dex}:${v3Fee}|${isStable ? 'stable' : 'vol'}] net: ${netStr}`);
        }

        const profitFormatted = isUsdcBase
            ? `${(Number(profit) / 1e6).toFixed(4)} USDC`
            : `${ethers.formatEther(profit)} ETH`;

        return {
            profitable: profit > minProfit,
            tokenBase, tokenTarget, dex, isStable,
            borrowAmount, v3Fee, buyOnV3First, profit,
            profitFormatted,
        };
    }

    // Aerodrome volatile AMM: x*y=k, 0.3% fee
    _ammOut(amountIn, reserveIn, reserveOut) {
        if (reserveIn === 0n || reserveOut === 0n || amountIn === 0n) return 0n;
        const amountInWithFee = amountIn * 9970n;
        return (amountInWithFee * reserveOut) / (reserveIn * 10000n + amountInWithFee);
    }

    // Aerodrome stable AMM: x³y + xy³ = k, 0.02% fee
    // Normalization: Aerodrome normalizes to 1e18 before computing invariant
    _stableAmmOut(amountIn, reserveIn, reserveOut, decIn = 18n, decOut = 18n) {
        if (reserveIn === 0n || reserveOut === 0n || amountIn === 0n) return 0n;
        const PREC = 10n ** 18n;
        // Normalize to 1e18
        const scaleIn  = PREC / (10n ** decIn);
        const scaleOut = PREC / (10n ** decOut);
        const rIn  = reserveIn  * scaleIn;
        const rOut = reserveOut * scaleOut;
        const aIn  = (amountIn * 9998n / 10000n) * scaleIn; // 0.02% fee
        const newRIn = rIn + aIn;
        const k = this._stableK(rIn, rOut);
        // Binary search for new rOut
        let lo = 0n, hi = rOut;
        for (let i = 0; i < 64; i++) {
            const mid = (lo + hi) / 2n;
            if (mid === lo) break;
            if (this._stableK(newRIn, mid) < k) lo = mid; else hi = mid;
        }
        const amountOutNorm = rOut > hi ? rOut - hi : 0n;
        // Denormalize result back to original decimals
        return amountOutNorm / scaleOut;
    }

    // Stable invariant: x³y + xy³
    _stableK(x, y) {
        return x * x * x * y + x * y * y * y;
    }

    // ── TX İCRASI ────────────────────────────────────────
    async _execute(opp) {
        // Eyni anda yalnız 1 TX — əvvəlki bitənə qədər yeni TX göndərmə
        if (this.executing) {
            log('⏳', 'TX icra olunur, növbəti fürsət gözlənilir...');
            return;
        }
        this.executing = true;
        try {
            const feeData = await this.provider.getFeeData();
            const tx = await this.arbExec.executeArbitrage({
                tokenBorrow:  opp.tokenBase,
                borrowAmount: opp.borrowAmount,
                tokenTarget:  opp.tokenTarget,
                buyOnV3First: opp.buyOnV3First,
                v3Fee:        opp.v3Fee,
                usePancake:   opp.dex === 'pancake',
                stablePool:   opp.isStable ?? false,
            }, {
                gasLimit: CONFIG.GAS_LIMIT,
                maxFeePerGas: feeData.maxFeePerGas,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
            });

            log('📤', `TX göndərildi: ${tx.hash}`);
            const receipt = await tx.wait();

            if (receipt.status === 1) {
                this.stats.executed++;
                this.stats.profitWei += opp.profit;
                log('✅', `UĞURLU! ${opp.profitFormatted} ETH | ${tx.hash}`);
            } else {
                this.stats.failed++;
                log('❌', `TX uğursuz: ${tx.hash}`);
            }
        } catch (err) {
            this.stats.failed++;
            if (err.message.includes('not profitable'))
                log('📉', 'Qiymət dəyişdi, artıq gəlirli deyil');
            else
                log('❌', `Xəta: ${err.message.slice(0, 120)}`);
        } finally {
            this.executing = false;
        }
    }

    // ── ÜÇBUCAQ ARBİTRAJ ──────────────────────────────────
    // WETH → B → C → WETH (3 hop, UniV3 multi-hop quote)
    async _scanTriangles() {
        const weth = ADDR.WETH;

        // Aktiv cütlərdən bütün unikal tokenləri topla
        const tokenSet = new Set();
        for (const p of this.pairs.values()) {
            if (p.token0.toLowerCase() !== weth.toLowerCase()) tokenSet.add(p.token0);
            if (p.token1.toLowerCase() !== weth.toLowerCase()) tokenSet.add(p.token1);
        }
        const tokens = [...tokenSet];
        if (tokens.length < 2) return;

        // Yoxlanılacaq fee kombinasiyaları: [hop1, hop2, hop3]
        const FEE_COMBOS = [
            [100, 100, 100],
            [500, 100, 500],
            [500, 500, 500],
            [3000, 500, 3000],
            [100, 500, 100],
        ];

        let routesChecked = 0;
        let found = 0;

        for (const b of tokens) {
            for (const c of tokens) {
                if (b.toLowerCase() === c.toLowerCase()) continue;

                for (const borrow of CONFIG.BORROW_AMOUNTS) {
                    const flashFee  = (borrow * 5n) / 10000n;
                    const totalOwed = borrow + flashFee;

                    for (const [f1, f2, f3] of FEE_COMBOS) {
                        try {
                            // Encoded path: WETH -f1→ B -f2→ C -f3→ WETH
                            const path = ethers.solidityPacked(
                                ['address','uint24','address','uint24','address','uint24','address'],
                                [weth, f1, b, f2, c, f3, weth]
                            );
                            const raw = await this.quoter.quoteExactInput.staticCall(path, borrow);
                            const amountOut = Array.isArray(raw) ? raw[0] : raw;
                            routesChecked++;

                            if (amountOut > totalOwed) {
                                const profit = amountOut - totalOwed;
                                const profitEth = ethers.formatEther(profit);
                                found++;
                                this.stats.found++;
                                log('🔺', `ÜÇBUCAq! ${b.slice(0,8)}…→${c.slice(0,8)}… fees:[${f1},${f2},${f3}] borrow:${ethers.formatEther(borrow)} | +${profitEth} ETH`);
                                if (this.dryRun) log('🧪', '[DRY RUN] Triangle sim — real tx üçün smart contract yenilənməlidir');
                            }
                        } catch { /* bu fee kombinasiyası pool yoxdur */ }
                    }
                    break; // İlk profitable borrow amount tapıldıqda növbəti cütə keç
                }
            }
        }

        log('🔺', `Üçbucaq scan: ${tokens.length} token → ${routesChecked} route yoxlandı | ${found > 0 ? found + ' FÜRSƏT!' : 'fürsət yoxdur'}`);
    }

    // ── BACKUP SCAN ───────────────────────────────────────
    _startBackupScan() {
        setInterval(() => {
            this.scorer.decay();
            for (const [key] of this.scorer.top(10)) {
                const p = this.pairs.get(key);
                if (p) this._triggerCheck(p.token0, p.token1);
            }
        }, CONFIG.BACKUP_SCAN_MS);
    }

    // ── HOT SCAN: TOP CÜTLƏRİ HƏR 1 SANİYƏDƏ YOXLA ──────
    // Event gəlmədən belə, top cütlər daim yoxlanır.
    // Büyük swap-ların arası çox qısa ola bilər — bunu tutmaq üçün.
    _startHotScan() {
        // HOT cütlər: əvvəlcədən məlum, fürsət tapılmış cütlər
        const HOT_PAIRS = [
            [ADDR.WETH, ADDR.AERO],   // ən çox fürsət tapılan
            [ADDR.WETH, ADDR.USDC],
            ['0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', ADDR.WETH], // cbBTC
        ];

        setInterval(() => {
            for (const [t0, t1] of HOT_PAIRS) {
                // debounce-siz birbaşa yoxla (hot path)
                const key = [t0, t1].sort().join('-').toLowerCase();
                const pairInfo = this.pairs.get(key);
                if (!pairInfo) continue;
                this._checkAndExecute(t0, t1).catch(() => {});
            }
        }, CONFIG.HOT_SCAN_MS);
    }

    // ── STATUS ────────────────────────────────────────────
    _printStatus() {
        const min = ((Date.now() - this.stats.start) / 60_000).toFixed(1);
        log('─'.repeat(55), '');
        log('📊', `STATUS ${min}dəq | İzlənən cütlər: ${this.pairs.size} | Seed tokenlar: ${this.discovery.seedTokens.length}`);
        log('⚡', `Events: ${this.stats.events} | Yoxlamalar: ${this.stats.checks}`);
        log('💎', `Fürsətlər: ${this.stats.found} | ✅${this.stats.executed} ❌${this.stats.failed}`);
        log('💰', `Profit: ${ethers.formatEther(this.stats.profitWei)} ETH`);
        const top = this.scorer.top(3);
        if (top.length)
            log('🏆', `Top: ${top.map(([k,s]) => `${k.slice(0,13)} (${s.toFixed(0)})`).join(' | ')}`);
        log('─'.repeat(55), '');
    }
}

// ============ START ============
const bot = new DynamicArbBot();

function save() {
    const fs = require('fs');
    fs.writeFileSync('arb_results.json', JSON.stringify({
        stats:    { ...bot.stats, profitWei: bot.stats.profitWei.toString() },
        pairs:    bot.pairs.size,
        topPairs: bot.scorer.top(20),
    }, null, 2));
    log('💾', 'arb_results.json saxlanıldı');
}

process.on('SIGINT', () => { log('🛑', 'Dayandırılır...'); save(); process.exit(0); });
setInterval(save, 5 * 60_000);

bot.start().catch(err => { log('💥', err.message); save(); process.exit(1); });
