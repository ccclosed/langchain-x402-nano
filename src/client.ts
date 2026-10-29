import { GuardRefusal, PaymentGuard, type Accepted, type Quote } from "./guard.js";

/** Signs exactly one Nano send block of `amount` raw to `payTo`. Injected by the operator; never sees the guard's config. */
export interface NanoSigner {
  account(): Promise<string>;
  signSend(args: {
    payTo: string;
    amount: bigint;
    workRequired: boolean;
    origin: string;
  }): Promise<{ block: Record<string, unknown>; hash: string }>;
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

const b64 = (o: unknown) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const unb64 = (s: string) => JSON.parse(decodeURIComponent(escape(atob(s))));

export function requestKey(url: string, method = "GET", body = ""): string {
  return `${method.toUpperCase()} ${url} ${body}`;
}

/**
 * Fetch `url`; on a 402 quoting x402 exact on nano, run the guard, sign one send block and
 * re-present the request with the payment-signature header. Same-origin redirects are followed
 * on the unsigned probe only; a cross-origin redirect is refused before anything is signed.
 * A stale quote is refused, a second invocation for the same request never signs a second block,
 * and a paid non-2xx is never retried with a new block.
 */
export async function paidFetch(
  url: string,
  guard: PaymentGuard,
  signer: NanoSigner,
  opts: PaidFetchOptions = {}
): Promise<PaidResult> {
  const f = opts.fetch ?? fetch;
  const method = (opts.method ?? "GET").toUpperCase();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startOrigin = new URL(url).origin;
  const key = requestKey(url, method, opts.body ?? "");
  const init = (extra: Record<string, string> = {}): RequestInit => ({
    method,
    body: opts.body,
    redirect: "manual",
    headers: { ...(opts.headers ?? {}), ...extra },
  });

  // 1. Unsigned probe. Follow same-origin redirects only.
  let cur = url;
  let res: Response | undefined;
  for (let hop = 0; hop <= 20; hop++) {
    res = await f(cur, init());
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      const next = new URL(res.headers.get("location")!, cur).toString();
      if (new URL(next).origin !== startOrigin)
        throw new GuardRefusal("cross_origin", `redirect to ${new URL(next).origin} refused; nothing signed`);
      cur = next;
      continue;
    }
    break;
  }
  if (!res) throw new Error("no response");
  if (res.status !== 402)
    return { status: res.status, body: await res.text(), contentType: res.headers.get("content-type"), paid: false };

  // 2. Decode the quote.
  const hdr = res.headers.get("payment-required");
  let required: unknown;
  try {
    if (hdr) required = unb64(hdr);
    else required = (JSON.parse(await res.text()) as { x402?: unknown }).x402;
  } catch {
    throw new GuardRefusal("malformed", "PAYMENT-REQUIRED could not be decoded");
  }
  const accepted: Accepted = guard.pick(required);
  const quote: Quote = {
    required: required as Quote["required"],
    accepted,
    origin: new URL(cur).origin,
    receivedAt: Date.now(),
  };

  // 3. Guard, before any signing.
  const ticket = guard.authorize(quote, cur, key);
  let signed: { block: Record<string, unknown>; hash: string };
  try {
    const extra = accepted.extra ?? {};
    const workRequired = !(extra.workOptional === true || extra.work === "optional");
    signed = await signer.signSend({ payTo: accepted.payTo, amount: ticket.amount, workRequired, origin: quote.origin });
    if (guard.isStale(quote)) throw new GuardRefusal("stale_quote", "quote expired while signing; nothing sent");
  } catch (e) {
    ticket.release();
    throw e;
  }
  ticket.commit(); // from here the block may reach the chain: count it, never sign again for this key

  // 4. One paid request, no redirects followed. Re-present the SAME payload only while the seller says it is confirming.
  const payload = { x402Version: 2, resource: quote.required.resource, accepted, payload: { block: signed.block } };
  const headers: Record<string, string> = { "payment-signature": b64(payload) };
  const deadline = Date.now() + (opts.representForMs ?? 60_000);
  let paidRes = await f(cur, init(headers));
  while (paidRes.status === 402 && Date.now() < deadline) {
    const tok = paidRes.headers.get("x-nano-represent");
    if (!tok) break;
    headers["x-nano-represent"] = tok;
    await sleep(2000);
    paidRes = await f(cur, init(headers));
  }
  return {
    status: paidRes.status,
    body: await paidRes.text(),
    contentType: paidRes.headers.get("content-type"),
    paid: true,
    blockHash: signed.hash,
    amountRaw: ticket.amount.toString(),
  };
}