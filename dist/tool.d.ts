import { DynamicStructuredTool } from "@langchain/core/tools";
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
/**
 * Build a LangChain tool that fetches a URL and, if the resource answers 402 with an x402
 * `exact` quote on nano:mainnet, pays it from the configured Nano account within the operator's
 * caps, then returns the body plus the send-block hash.
 *
 * Every guard runs before anything is signed: network, payTo allowlist, per-call cap,
 * cumulative cap, cross-origin refusal, malformed/stale quote refusal, and one block per
 * request (a repeated or concurrent call for the same request is refused).
 */
export declare function createNanoX402Tool(config?: NanoX402ToolConfig): DynamicStructuredTool;
