import { PaymentGuard } from "./guard.js";
/** Signs exactly one Nano send block of `amount` raw to `payTo`. Injected by the operator; never sees the guard's config. */
export interface NanoSigner {
    account(): Promise<string>;
    signSend(args: {
        payTo: string;
        amount: bigint;
        workRequired: boolean;
        origin: string;
    }): Promise<{
        block: Record<string, unknown>;
        hash: string;
    }>;
}
export interface PaidFetchOptions {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    /** fetch implementation, injectable for tests. */
    fetch?: typeof fetch;
    /** How long to keep re-presenting the SAME signed payload while the seller waits for confirmation. */
    representForMs?: number;
    sleep?: (ms: number) => Promise<void>;
}
export interface PaidResult {
    status: number;
    body: string;
    contentType: string | null;
    paid: boolean;
    blockHash?: string;
    amountRaw?: string;
}
export declare function requestKey(url: string, method?: string, body?: string): string;
/**
 * Fetch `url`; on a 402 quoting x402 exact on nano, run the guard, sign one send block and
 * re-present the request with the payment-signature header. Same-origin redirects are followed
 * on the unsigned probe only; a cross-origin redirect is refused before anything is signed.
 * A stale quote is refused, a second invocation for the same request never signs a second block,
 * and a paid non-2xx is never retried with a new block.
 */
export declare function paidFetch(url: string, guard: PaymentGuard, signer: NanoSigner, opts?: PaidFetchOptions): Promise<PaidResult>;
