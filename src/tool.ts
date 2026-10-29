import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import { paidFetch } from "./client.js";
import { PaymentGuard, xnoToRaw } from "./guard.js";
import { createSeedSigner } from "./signer.js";

export interface NanoX402ToolConfig {
  /** Nano accounts the tool is allowed to pay. Required (or NANO_PAYTO_ALLOWLIST, comma separated). */
  payToAllowlist?: string[];
  /** Per-call cap in XNO decimal text. Default "0.001" (or NANO_MAX_PER_CALL). */
  maxPerCallXno?: string;
  /** Cumulative cap for this tool instance in XNO decimal text. Default "0.01" (or NANO_MAX_TOTAL). */
  maxTotalXno?: string;
  /** Accepted network. Default nano:mainnet. */
  network?: string;
  /** 64-hex seed of the paying account. Default NANO_SEED. Keep it out of prompts and logs. */
  seed?: string;
  accountIndex?: number;
  /** No-node account info service. Default https://pursekeeper.dev . */
  accountInfoApi?: string;
  /** RPC-style work_generate endpoint; default the seller's /v1/work, then local CPU work. */
  workUrl?: string;
  /** Inject fetch for tests. */
  fetch?: typeof fetch;
  /** How long to re-present the same signed payload while the seller confirms. */
  representForMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const splitList = (s: string | undefined): string[] =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Build a LangChain tool that fetches a URL and, if the resource answers 402 with an x402
 * `exact` quote on nano:mainnet, pays it from the configured Nano account within the operator's
 * caps, then returns the body plus the send-block hash.
 *
 * Every guard runs before anything is signed: network, payTo allowlist, per-call cap,
 * cumulative cap, cross-origin refusal, malformed/stale quote refusal, and one block per
 * request (a repeated or concurrent call for the same request is refused).
 */
export function createNanoX402Tool(config: NanoX402ToolConfig = {}): DynamicStructuredTool {
  const allowlist = config.payToAllowlist ?? splitList(process.env.NANO_PAYTO_ALLOWLIST);
  const maxPerCallRaw = xnoToRaw(config.maxPerCallXno ?? process.env.NANO_MAX_PER_CALL ?? "0.001");
  const maxTotalRaw = xnoToRaw(config.maxTotalXno ?? process.env.NANO_MAX_TOTAL ?? "0.01");
  const seed = config.seed ?? process.env.NANO_SEED;
  if (!seed) throw new Error("NANO_SEED is required: pass seed in the config or set the environment variable");
  if (!allowlist.length) throw new Error("payToAllowlist must name at least one Nano account (or set NANO_PAYTO_ALLOWLIST)");

  const guard = new PaymentGuard({
    network: config.network,
    payToAllowlist: allowlist,
    maxPerCallRaw,
    maxTotalRaw,
    now: config.now,
  });
  const signer = createSeedSigner({
    seed,
    index: config.accountIndex,
    accountInfoApi: config.accountInfoApi,
    workUrl: config.workUrl,
    fetch: config.fetch,
  });

  return new DynamicStructuredTool({
    name: "nano_x402_fetch",
    description:
      "Fetch a URL. If it answers 402 Payment Required with an x402 'exact' quote on nano:mainnet, " +
      "pay it in Nano from the operator's capped account and return the response body with the send-block hash. " +
      "The tool refuses networks other than nano:mainnet, payees outside the operator allowlist, quotes above the " +
      "per-call or cumulative cap, cross-origin redirects, stale/malformed quotes and a second payment for the same request.",
    schema: z.object({
      url: z.string().describe("Absolute URL to fetch, for example https://pursekeeper.dev/v1/fetch?url=https://example.com"),
      method: z.enum(["GET", "POST"]).optional().describe("HTTP method; default GET"),
      body: z.string().optional().describe("Request body for POST"),
    }),
    func: async ({ url, method, body }) => {
      const result = await paidFetch(url, guard, signer, {
        method,
        body,
        fetch: config.fetch,
        representForMs: config.representForMs,
      });
      return JSON.stringify({
        status: result.status,
        paid: result.paid,
        blockHash: result.blockHash ?? null,
        amountRaw: result.amountRaw ?? null,
        body: result.body,
      });
    },
  });
}