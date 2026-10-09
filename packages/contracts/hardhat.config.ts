import { createRequire } from "node:module";
import { defineConfig } from "hardhat/config";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";

const require = createRequire(import.meta.url);

export default defineConfig({
  plugins: [hardhatViem, hardhatNodeTestRunner, hardhatNetworkHelpers],
  solidity: {
    version: "0.8.30",
    // Use the pinned npm compiler: builds do not download a compiler separately.
    path: require.resolve("solc/soljson.js"),
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
});
