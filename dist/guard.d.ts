export declare const NANO_MAINNET = "nano:mainnet";
export declare const RAW_PER_XNO: bigint;
/** "0.001" -> 1000000000000000000000000000 raw */
export declare function xnoToRaw(xno: string): bigint;
export declare const normAccount: (a: string) => string;
export declare class GuardRefusal extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export interface GuardConfig {
    /** Network the operator accepts. Default nano:mainnet. */
    network?: string;
    /** Nano accounts the agent may pay. Required, non-empty: an empty allowlist fails closed. */
    payToAllowlist: string[];
    /** Maximum raw per single call. */
    maxPerCallRaw: bigint;
    /** Maximum cumulative raw for the life of this guard (one process / one agent run). */
    maxTotalRaw: bigint;
    /** Clock, injectable for tests. */
    now?: () => number;
}
export interface Accepted {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds?: number;
    extra?: Record<string, unknown>;
}
export interface Quote {
    required: {
        x402Version: number;
        resource: {
            url: string;
            [k: string]: unknown;
        };
        accepts: Accepted[];
    };
    accepted: Accepted;
    origin: string;
    receivedAt: number;
}
export declare class PaymentGuard {
    private readonly cfg;
    readonly network: string;
    private readonly allow;
    private spentRaw;
    private readonly paidKeys;
    private readonly inFlight;
    private readonly now;
    constructor(cfg: GuardConfig);
    get spent(): bigint;
    /** Pick the nano exact entry from a decoded PAYMENT-REQUIRED body; refuse anything malformed. */
    pick(required: unknown): Accepted;
    isStale(q: Quote): boolean;
    /**
     * Validate a quote and reserve its amount against the caps. Returns release() for the case
     * where nothing was signed. Throws GuardRefusal otherwise.
     * `key` identifies the logical request (method + url + body): a key that has paid, or is
     * paying right now, is refused so a second invocation never signs a second block.
     */
    authorize(q: Quote, requestUrl: string, key: string): {
        amount: bigint;
        commit(): void;
        release(): void;
    };
}
