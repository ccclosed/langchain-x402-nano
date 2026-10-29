import * as N from "nanocurrency";
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

const SEND_THRESHOLD = "fffffff800000000";

/**
 * Signer backed by a Nano seed. Reads the payer's frontier/balance from a node RPC or, with no
 * node, from the seller's account-info endpoint (pursekeeper.dev's free /v1/account_info), and
 * gets proof-of-work from a work endpoint or the seller's /v1/work, falling back to local CPU work.
 * The seed never leaves this closure: it is not logged, not returned and not put in the block.
 */
export function createSeedSigner(cfg: SeedSignerConfig): NanoSigner {
  if (!/^[0-9a-fA-F]{64}$/.test(cfg.seed ?? "")) throw new Error("NANO_SEED must be 64 hex characters");
  const secretKey = N.deriveSecretKey(cfg.seed, cfg.index ?? 0);
  const address = N.deriveAddress(N.derivePublicKey(secretKey), { useNanoPrefix: true });
  const f = cfg.fetch ?? fetch;
  const postJson = (url: string, body: unknown) =>
    f(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }).then((r) => r.json() as Promise<any>);

  async function accountInfo() {
    if (cfg.rpcUrl) {
      const info = await postJson(cfg.rpcUrl, { action: "account_info", account: address, representative: "true" });
      if (info.error) throw new Error(`account_info: ${info.error}`);
      return { frontier: info.frontier as string, balance: BigInt(info.balance), representative: info.representative as string };
    }
    const api = (cfg.accountInfoApi ?? "https://pursekeeper.dev").replace(/\/$/, "");
    const res = await f(`${api}/v1/account_info?account=${encodeURIComponent(address)}`);
    if (!res.ok) throw new Error(`account_info HTTP ${res.status}`);
    const info: any = await res.json();
    if (info.error) throw new Error(`account_info: ${info.error}`);
    if (!info.found) throw new Error("payer account has no blocks yet; receive the seed first");
    return {
      frontier: info.frontier as string,
      balance: BigInt(info.balance_raw),
      representative: info.representative as string,
    };
  }

  async function work(hash: string, origin: string): Promise<string> {
    if (cfg.workUrl) {
      const r = await postJson(cfg.workUrl, { action: "work_generate", hash, difficulty: SEND_THRESHOLD });
      if (r.work) return r.work as string;
    }
    try {
      const r = await postJson(`${origin}/v1/work`, { hash });
      if (r.work) return r.work as string;
    } catch {
      /* fall through to local work */
    }
    const local = await N.computeWork(hash, { workThreshold: SEND_THRESHOLD });
    if (!local) throw new Error("could not compute work");
    return local;
  }

  return {
    account: async () => address,
    async signSend({ payTo, amount, workRequired, origin }) {
      const info = await accountInfo();
      if (info.balance < amount) throw new Error(`balance ${info.balance} raw < ${amount} raw`);
      const workValue = workRequired ? await work(info.frontier, origin) : null;
      const { block, hash } = N.createBlock(secretKey, {
        work: workValue,
        previous: info.frontier,
        representative: info.representative,
        balance: (info.balance - amount).toString(),
        link: payTo,
      });
      (block as any).account = String(block.account).replace(/^xrb_/, "nano_");
      return { block: block as unknown as Record<string, unknown>, hash };
    },
  };
}