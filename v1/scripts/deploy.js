const hre = require("hardhat");

async function main() {
  const AaveV3PoolAddressesProvider = "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D";
  console.log("Deploying FlashArbBot with Aave V3 Provider:", AaveV3PoolAddressesProvider);

  const FlashArbBot = await hre.ethers.getContractFactory("FlashArbBot");
  const bot = await FlashArbBot.deploy(AaveV3PoolAddressesProvider);

  await bot.waitForDeployment();
  const address = await bot.getAddress();

  console.log(`FlashArbBot deployed to: ${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
