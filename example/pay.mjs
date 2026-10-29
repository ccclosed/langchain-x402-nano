// One paid call, no LLM key: the LangChain tool is invoked directly.
//   NANO_SEED=<64-hex> node example/pay.mjs
//   NANO_X402_URL=https://pursekeeper.dev/v1/fetch?url=https://example.com (default)
import { createNanoX402Tool } from "langchain-x402-nano";

const tool = createNanoX402Tool({
  payToAllowlist: (process.env.NANO_PAYTO_ALLOWLIST ?? "nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue").split(","),
  maxPerCallXno: process.env.NANO_MAX_PER_CALL ?? "0.001",
  maxTotalXno: process.env.NANO_MAX_TOTAL ?? "0.01",
});

const url = process.env.NANO_X402_URL ?? "https://pursekeeper.dev/v1/fetch?url=https://example.com";
const out = await tool.invoke({ url });
console.log(out);
