# ============================================
# FLASH LOAN ARBITRAGE BOT - QURAŞDIRMA BƏLƏDÇISI
# Base Chain | Uniswap V3 ↔ SushiSwap V2
# ============================================

## 📋 ÖN ŞƏRTLƏR

1. Node.js (v18+): https://nodejs.org
2. MetaMask cüzdan (Base chain əlavə edilmiş)
3. ~$10 ETH (Base chain-də) - gas fee üçün
4. Əgər sürətli RPC istəsən: Alchemy/Infura hesabı (pulsuz tier kifayətdir)

---

## 🚀 ADDIM-ADDIM QURAŞDIRMA

### Addım 1: Layihəni qur
```bash
mkdir flash-arb && cd flash-arb
npm init -y
npm install ethers@6 dotenv
```

### Addım 2: .env faylı yarat
```bash
cp .env.example .env
# Sonra .env faylını redaktə et - PRIVATE_KEY əlavə et
```

### Addım 3: Smart Contract-ı deploy et

**Remix ilə (ən asan yol):**
1. https://remix.ethereum.org aç
2. `FlashArbBot.sol` faylını yarat, kodu yapışdır
3. Compiler → 0.8.10 seç, compile et
4. Deploy → Environment: "Injected Provider" (MetaMask)
5. MetaMask-da Base şəbəkəsinə keç
6. Constructor-a Aave V3 PoolAddressesProvider ünvanını daxil et:
   `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D`
7. Deploy et, contract ünvanını kopyala
8. .env faylına ARB_CONTRACT= olaraq yapışdır

**Hardhat ilə (daha professional):**
```bash
npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox
npx hardhat init
# hardhat.config.js-ə Base network əlavə et
# scripts/deploy.js yaz və npx hardhat run scripts/deploy.js --network base
```

### Addım 4: Botu işə sal
```bash
# Əvvəlcə DRY RUN (simulyasiya - real pul xərclənmir)
node bot.js --dry-run

# Hər şey yaxşı görünürsə, LIVE rejim
node bot.js
```

---

## 📁 FAYL STRUKTURU

```
flash-arb/
├── contracts/
│   └── FlashArbBot.sol     ← Smart contract (Remix-ə kopyala)
├── bot.js                   ← Əsas bot script
├── .env                     ← Gizli açarlar (PAYLAŞMA!)
├── .env.example             ← .env nümunəsi
├── arb_results.json         ← Bot nəticələri (avtomatik yaranır)
├── package.json
└── README.md                ← Bu fayl
```

---

## ⚙️ KONFİQURASİYA

### .env faylı:
```env
# Base Chain RPC
RPC_URL=https://mainnet.base.org

# Deploy etdiyin contract ünvanı
ARB_CONTRACT=0xYOUR_CONTRACT_ADDRESS

# Cüzdan private key (heç vaxt paylaşma!)
PRIVATE_KEY=your_private_key_here
```

### bot.js-dəki parametrlər:
- `BORROW_AMOUNTS` - Flash loan məbləğləri (daha böyük = daha çox profit potensialı)
- `MIN_PROFIT_WEI` - Minimum qazanc həddi
- `CHECK_INTERVAL` - Yoxlama sıxlığı (ms)
- `UNI_V3_FEES` - Uniswap V3 fee tierləri

---

## 🔄 OPTİMALLAŞDIRMA DÖVRÜ

Bu bot "öyrənən" sistemdir. İş axını:

1. **Test et** → `node bot.js --dry-run` (5-10 dəq izlə)
2. **Analiz et** → `arb_results.json` faylını mənə göstər
3. **Mən optimallaşdırım** → Hansı cütlər gəlirlidir? Hansı fee tier yaxşıdır?
4. **Kodu yenilə** → Yeni parametrlərlə yenidən test et
5. **Təkrarla** → Hər iterasiya ilə bot daha ağıllı olur

### Mənə göstərəcəyin məlumatlar:
- `arb_results.json` faylının məzmunu
- Hansı token cütlərində fürsət tapıldı
- Gas xərcləri
- Uğursuz əməliyyatların səbəbləri

---

## ⚠️ VACİB XƏBƏRDARLIQLAR

### Təhlükəsizlik:
- **PRIVATE KEY-i heç vaxt paylaşma** (GitHub, Discord, heç yerə!)
- Yeni cüzdan istifadə et (əsas vəsaitlərin olduğu cüzdan deyil)
- Ayrı cüzdanda yalnız gas fee üçün lazım olan ETH saxla (~$10)
- `.gitignore`-a `.env` əlavə et

### Risklər:
- Gas fee: Hər uğursuz əməliyyat ~$0.01-0.05 (Base-də)
- Smart contract riski: Audit olunmamış contract
- Rəqabət: Peşəkar botlar sizin əməliyyatınızı qabağlaya bilər
- Slippage: Qiymət əməliyyat zamanı dəyişə bilər

### Gas büdcəsi:
- Base-də bir əməliyyat: ~$0.01-0.05
- $10 ilə: 200-1000 test edə bilərsiniz
- Uğursuz flash loan: yalnız gas itirilir, borc qaytarılmadığı üçün əməliyyat ləğv olunur

---

## 🎯 STRATEGİYA TÖVSİYƏLƏRİ

### Başlanğıc üçün:
1. WETH/USDC cütü ilə başla (ən çox likvidlik)
2. Kiçik borrow amount (0.1 ETH) ilə test et
3. Fee tier 3000 (0.3%) ən çox istifadə olunan
4. Volatil vaxtlarda (xəbərlər, bazar açılışı) daha çox fürsət olur

### İrəlilədikcə:
1. Daha çox token cütü əlavə et
2. Üçbucaq arbitrajı əlavə et (3 token)
3. Mempool izləmə əlavə et (pending txlərdən öncə hərəkət et)
4. Çoxlu DEX əlavə et (Aerodrome, BaseSwap, və s.)
5. Cross-chain arbitraj (Base ↔ Arbitrum ↔ Optimism)

---

## 📊 GÖZLƏNƏN NƏTİCƏLƏR

### Realist:
- İlk həftə: Çox ehtimal 0 qazanc, amma prosesi öyrənəcəksiniz
- İlk ay: Kiçik fürsətlər tapıla bilər ($0.10-5 arasında)
- Optimallaşdırmadan sonra: Gündə $0-50 arası (heç bir zəmanət yoxdur)

### Gas xərci:
- 100 test = ~$1-5 (Base-də)
- 10 dollarlıq büdcə = 200-1000 test imkanı

---

## 🆘 YARDIM

Hər hansı addımda ilişsən, mənə bunları göstər:
1. Xəta mesajı (tam kopyala)
2. `arb_results.json` faylı
3. Hansı addımda olduğun

Birlikdə həll edərik! 🤝
