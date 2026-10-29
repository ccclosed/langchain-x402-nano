// Payment guard: every check here runs before anything is signed.
export const NANO_MAINNET = "nano:mainnet";
export const RAW_PER_XNO = 10n ** 30n;
const MAX_NANO_RAW = 2n ** 128n - 1n;
const ADDR = /^(nano|xrb)_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/;

/** "0.001" -> 1000000000000000000000000000 raw */
export function xnoToRaw(xno: string): bigint {
  if (!/^\d+(\.\d{1,30})?$/.test(xno)) throw new Error(`bad XNO amount ${JSON.stringify(xno)}`);
  const [whole, frac = ""] = xno.split(".");
  return BigInt(whole) * RAW_PER_XNO + BigInt((frac + "0".repeat(30)).slice(0, 30));
}

export const normAccount = (a: string) => a.replace(/^xrb_/, "nano_");

export class GuardRefusal extends Error {
  constructor(public readonly code: string, message: string) {
    super(`payment refused (${code}): ${message}`);
    this.name = "GuardRefusal";
  }
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
  required: { x402Version: number; resource: { url: string;[k: string]: unknown }; accepts: Accepted[] };
  accepted: Accepted;
  origin: string;
  receivedAt: number;
}

export class PaymentGuard {
  readonly network: string;
  private readonly allow: Set<string>;
  private spentRaw = 0n;
  private readonly paidKeys = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly cfg: GuardConfig) {
    if (!cfg.payToAllowlist?.length) throw new Error("payToAllowlist must name at least one Nano account");
    if (cfg.maxPerCallRaw <= 0n || cfg.maxTotalRaw <= 0n) throw new Error("caps must be positive");
    this.network = cfg.network ?? NANO_MAINNET;
    this.allow = new Set(cfg.payToAllowlist.map(normAccount));
    this.now = cfg.now ?? Date.now;
  }

  get spent(): bigint {
    return this.spentRaw;
  }

  /** Pick the nano exact entry from a decoded PAYMENT-REQUIRED body; refuse anything malformed. */
  pick(required: unknown): Accepted {
    const r = required as Quote["required"];
    if (!r || typeof r !== "object" || r.x402Version !== 2)
      throw new GuardRefusal("malformed", "PAYMENT-REQUIRED is not an x402 v2 body");
    if (!r.resource || typeof r.resource.url !== "string" || !r.resource.url)
      throw new GuardRefusal("malformed", "resource.url missing");
    if (!Array.isArray(r.accepts) || !r.accepts.length)
      throw new GuardRefusal("malformed", "accepts is empty");
    const exact = r.accepts.filter((a) => a && a.scheme === "exact");
    if (!exact.length) throw new GuardRefusal("malformed", "no exact scheme offered");
    const onNet = exact.find((a) => a.network === this.network);
    if (!onNet)
      throw new GuardRefusal("wrong_network", `no exact entry on ${this.network} (offered: ${exact.map((a) => a.network).join(", ")})`);
    return onNet;
  }

  isStale(q: Quote): boolean {
    const ttl = (q.accepted.maxTimeoutSeconds ?? 60) * 1000;
    return this.now() - q.receivedAt >= ttl;
  }

  /**
   * Validate a quote and reserve its amount against the caps. Returns release() for the case
   * where nothing was signed. Throws GuardRefusal otherwise.
   * `key` identifies the logical request (method + url + body): a key that has paid, or is
   * paying right now, is refused so a second invocation never signs a second block.
   */
  authorize(q: Quote, requestUrl: string, key: string): { amount: bigint; commit(): void; release(): void } {
    const a = q.accepted;
    if (a.network !== this.network) throw new GuardRefusal("wrong_network", `quote is on ${a.network}, operator allows ${this.network}`);
    if (a.scheme !== "exact") throw new GuardRefusal("malformed", `scheme ${a.scheme}`);
    if (String(a.asset).toUpperCase() !== "XNO") throw new GuardRefusal("malformed", `asset ${JSON.stringify(a.asset)}`);
    if (typeof a.payTo !== "string" || !ADDR.test(normAccount(a.payTo)))
      throw new GuardRefusal("malformed", `payTo ${JSON.stringify(a.payTo)} is not a Nano address`);
    if (typeof a.amount !== "string" || !/^[1-9]\d*$/.test(a.amount))
      throw new GuardRefusal("malformed", `amount ${JSON.stringify(a.amount)}`);
    const amount = BigInt(a.amount);
    if (amount > MAX_NANO_RAW) throw new GuardRefusal("malformed", "amount above Nano supply");
    if (a.maxTimeoutSeconds !== undefined && (typeof a.maxTimeoutSeconds !== "number" || !(a.maxTimeoutSeconds > 0)))
      throw new GuardRefusal("malformed", "maxTimeoutSeconds invalid");

    const reqOrigin = new URL(requestUrl).origin;
    if (q.origin !== reqOrigin) throw new GuardRefusal("cross_origin", `quote came from ${q.origin}, request was to ${reqOrigin}`);
    let resOrigin: string;
    try {
      resOrigin = new URL(q.required.resource.url).origin;
    } catch {
      throw new GuardRefusal("malformed", "resource.url is not a URL");
    }
    if (resOrigin !== reqOrigin) throw new GuardRefusal("cross_origin", `resource.url points at ${resOrigin}`);
    if (!this.allow.has(normAccount(a.payTo))) throw new GuardRefusal("payto_not_allowed", `${a.payTo} is not in the operator allowlist`);
    if (amount > this.cfg.maxPerCallRaw) throw new GuardRefusal("over_call_cap", `${amount} raw > per-call cap ${this.cfg.maxPerCallRaw}`);
    if (this.spentRaw + amount > this.cfg.maxTotalRaw)
      throw new GuardRefusal("over_total_cap", `${this.spentRaw} + ${amount} raw > cumulative cap ${this.cfg.maxTotalRaw}`);
    if (this.isStale(q)) throw new GuardRefusal("stale_quote", "quote older than maxTimeoutSeconds; re-fetch it");
    if (this.paidKeys.has(key) || this.inFlight.has(key))
      throw new GuardRefusal("duplicate", "this request was already paid (or is being paid)");

    this.spentRaw += amount;
    this.inFlight.add(key);
    let done = false;
    return {
      amount,
      commit: () => {
        if (done) return;
        done = true;
        this.inFlight.delete(key);
        this.paidKeys.add(key);
      },
      release: () => {
        if (done) return;
        done = true;
        this.inFlight.delete(key);
        this.spentRaw -= amount;
      },
    };
  }
}