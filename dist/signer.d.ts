import type { NanoSigner } from "./client.js";
export interface SeedSignerConfig {
    /** 64-hex seed. Use NANO_SEED from the environment or inject a signer; never commit it. */
    seed: string;
    index?: number;
    /** Optional node RPC for account_info; default is the no-node account info service at `accountInfoApi`. */
    rpcUrl?: string;
    /** No-node account info service. Default https://pursekeeper.dev . */
    accountInfoApi?: string;
    /** RPC-style work_generate endpoint; default is the seller's own POST /v1/work, then local CPU work. */
    workUrl?: string;
    fetch?: typeof fetch;
}
/**
 * Signer backed by a Nano seed. Reads the payer's frontier/balance from a node RPC or, with no
 * node, from the seller's account-info endpoint (pursekeeper.dev's free /v1/account_info), and
 * gets proof-of-work from a work endpoint or the seller's /v1/work, falling back to local CPU work.
 * The seed never leaves this closure: it is not logged, not returned and not put in the block.
 */
export declare function createSeedSigner(cfg: SeedSignerConfig): NanoSigner;
