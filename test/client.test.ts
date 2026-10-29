import { describe, expect, it, vi } from "vitest";
import { paidFetch, type NanoSigner } from "../src/client.js";
import { GuardRefusal, PaymentGuard, xnoToRaw, type Accepted } from "../src/guard.js";

const PAY_TO = "nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue";
const URL0 = "https://pursekeeper.dev/v1/fetch?url=https://example.com";
const BLOCK_HASH = "ab".repeat(32);

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

function quote(over: Partial<Accepted> = {}) {
  const accepted: Accepted = {
    scheme: "exact",
    network: "nano:mainnet",
    amount: "1000000000000000000000000000",
    asset: "XNO",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { workOptional: true },
    ...over,
  };
  return { x402Version: 2, resource: { url: URL0 }, accepts: [accepted] };
}

const make402 = (body = quote()) =>
  new Response("payment required", { status: 402, headers: { "payment-required": b64(body) } });

function signer(over: Partial<NanoSigner> = {}): NanoSigner {
  return {
    account: async () => "nano_39qcg8g856n7r7r4ruxbaftybed6qk7fb9wywa9uefjodp5548mwoyeojfxb",
    signSend: vi.fn(async () => ({ block: { type: "state" }, hash: BLOCK_HASH })),
    ...over,
  };
}

function newGuard(over: Partial<ConstructorParameters<typeof PaymentGuard>[0]> = {}) {
  return new PaymentGuard({
    payToAllowlist: [PAY_TO],
    maxPerCallRaw: xnoToRaw("0.001"),
    maxTotalRaw: xnoToRaw("0.01"),
    ...over,
  });
}

describe("paidFetch", () => {
  it("does not pay when the resource answers without a 402", async () => {
    const f = vi.fn(async () => new Response("free", { status: 200 }));
    const s = signer();
    const r = await paidFetch(URL0, newGuard(), s, { fetch: f });
    expect(r).toMatchObject({ status: 200, paid: false, body: "free" });
    expect(s.signSend).not.toHaveBeenCalled();
  });

  it("pays exactly one block and re-presents the request with the payment-signature header", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(make402())
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));
    const s = signer();
    const r = await paidFetch(URL0, newGuard(), s, { fetch: f });

    expect(s.signSend).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(2);
    const paidCall = f.mock.calls[1] as unknown as [string, RequestInit];
    const header = (paidCall[1].headers as Record<string, string>)["payment-signature"];
    const payload = JSON.parse(Buffer.from(header, "base64").toString());
    expect(payload).toMatchObject({ x402Version: 2, payload: { block: { type: "state" } } });
    expect(r).toMatchObject({ status: 200, paid: true, blockHash: BLOCK_HASH, amountRaw: "1000000000000000000000000000" });
  });

  it("refuses a second invocation for the same request without signing again", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(make402())
      .mockResolvedValueOnce(new Response("no", { status: 500 }))
      .mockResolvedValueOnce(make402());
    const g = newGuard();
    const s = signer();

    const first = await paidFetch(URL0, g, s, { fetch: f });
    expect(first.paid).toBe(true); // signed, then the seller answered 500: no retry with a new block
    await expect(paidFetch(URL0, g, s, { fetch: f })).rejects.toThrow(/already paid/);
    expect(s.signSend).toHaveBeenCalledTimes(1);
  });

  it("never signs on a cross-origin redirect", async () => {
    const f = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/pay" } }));
    const s = signer();
    await expect(paidFetch(URL0, newGuard(), s, { fetch: f })).rejects.toThrow(/cross_origin/);
    expect(s.signSend).not.toHaveBeenCalled();
  });

  it("refuses a quote it cannot decode before signing", async () => {
    const f = vi.fn(async () => new Response("x", { status: 402, headers: { "payment-required": "not-base64-json" } }));
    const s = signer();
    await expect(paidFetch(URL0, newGuard(), s, { fetch: f })).rejects.toThrow(/malformed/);
    expect(s.signSend).not.toHaveBeenCalled();
  });

  it("refuses a stale quote when it expires while signing and nothing is sent", async () => {
    let shift = 0;
    const g = newGuard({ now: () => Date.now() + shift });
    const s = signer({
      signSend: vi.fn(async () => {
        shift = 120_000; // the signing step (work generation) takes longer than maxTimeoutSeconds
        return { block: { type: "state" }, hash: BLOCK_HASH };
      }),
    });
    const f = vi.fn(async () => make402());
    await expect(paidFetch(URL0, g, s, { fetch: f })).rejects.toThrow(/stale/);
    expect(f).toHaveBeenCalledTimes(1); // the paid request was never made
    expect(g.spent).toBe(0n); // nothing counted
  });

  it("re-presents the same payload only while the seller asks for it", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(make402())
      .mockResolvedValueOnce(new Response("pending", { status: 402, headers: { "x-nano-represent": "tok-1" } }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const s = signer();
    const r = await paidFetch(URL0, newGuard(), s, { fetch: f, sleep: async () => {} });

    expect(r).toMatchObject({ status: 200, paid: true, blockHash: BLOCK_HASH });
    expect(s.signSend).toHaveBeenCalledTimes(1);
    const calls = f.mock.calls.map((c) => c as unknown as [string, RequestInit]);
    const sigs = calls.slice(1).map(([, init]) => (init.headers as Record<string, string>)["payment-signature"]);
    expect(new Set(sigs).size).toBe(1); // exactly the same signed payload each time
    expect((calls[2][1].headers as Record<string, string>)["x-nano-represent"]).toBe("tok-1");
  });

  it("does not retry a paid non-2xx with a new block", async () => {
    const f = vi.fn().mockResolvedValueOnce(make402()).mockResolvedValueOnce(new Response("err", { status: 502 }));
    const s = signer();
    const r = await paidFetch(URL0, newGuard(), s, { fetch: f });
    expect(r).toMatchObject({ status: 502, paid: true });
    expect(s.signSend).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(2);
  });
});