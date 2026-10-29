import { describe, expect, it } from "vitest";
import { GuardRefusal, PaymentGuard, xnoToRaw, type Accepted, type Quote } from "../src/guard.js";

const PAY_TO = "nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue";
const PAY_TO_2 = "nano_39qcg8g856n7r7r4ruxbaftybed6qk7fb9wywa9uefjodp5548mwoyeojfxb";
const RESOURCE = "https://pursekeeper.dev/v1/fetch?url=https://example.com";

function accepted(over: Partial<Accepted> = {}): Accepted {
  return {
    scheme: "exact",
    network: "nano:mainnet",
    amount: "1000000000000000000000000000",
    asset: "XNO",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { workOptional: true },
    ...over,
  };
}

function quote(over: Partial<Accepted> = {}, now = Date.now()): Quote {
  const a = accepted(over);
  return {
    accepted: a,
    origin: "https://pursekeeper.dev",
    receivedAt: now,
    required: { x402Version: 2, resource: { url: RESOURCE }, accepts: [a] },
  };
}

function guard(over: Partial<ConstructorParameters<typeof PaymentGuard>[0]> = {}): PaymentGuard {
  return new PaymentGuard({
    payToAllowlist: [PAY_TO],
    maxPerCallRaw: xnoToRaw("0.001"),
    maxTotalRaw: xnoToRaw("0.01"),
    ...over,
  });
}

describe("xnoToRaw", () => {
  it("converts decimal XNO to raw", () => {
    expect(xnoToRaw("0.001")).toBe(10n ** 27n);
    expect(xnoToRaw("1")).toBe(10n ** 30n);
    expect(xnoToRaw("0.000000000000000000000000000001")).toBe(1n);
  });
  it("rejects junk amounts", () => {
    for (const bad of ["-1", "1e3", "", ".5", "1.", "abc"]) expect(() => xnoToRaw(bad)).toThrow();
  });
});

describe("PaymentGuard.pick", () => {
  it("picks the nano:mainnet exact entry", () => {
    const q = quote();
    expect(guard().pick(q.required)).toEqual(q.accepted);
  });
  it("refuses a quote without nano:mainnet", () => {
    const q = quote({ network: "nano:betanet" });
    expect(() => guard().pick(q.required)).toThrow(GuardRefusal);
    try {
      guard().pick(q.required);
    } catch (e) {
      expect((e as GuardRefusal).code).toBe("wrong_network");
    }
  });
  it("refuses garbage", () => {
    for (const bad of [null, {}, { x402Version: 1 }, { x402Version: 2, resource: {}, accepts: [] }]) {
      expect(() => guard().pick(bad)).toThrow(GuardRefusal);
    }
  });
});

describe("PaymentGuard.authorize", () => {
  it("accepts a quote inside the caps and counts it on commit", () => {
    const g = guard();
    const q = quote();
    const t = g.authorize(q, RESOURCE, "GET " + RESOURCE);
    expect(t.amount).toBe(10n ** 27n);
    t.commit();
    expect(g.spent).toBe(10n ** 27n);
  });
  it("undisclaims the amount when nothing was signed", () => {
    const g = guard();
    const t = g.authorize(quote(), RESOURCE, "k");
    t.release();
    expect(g.spent).toBe(0n);
  });
  it("refuses a payee outside the allowlist", () => {
    expect(() => guard().authorize(quote({ payTo: PAY_TO_2 }), RESOURCE, "k")).toThrow(/allowlist/);
  });
  it("refuses a quote above the per-call cap", () => {
    expect(() => guard().authorize(quote({ amount: (10n ** 27n * 2n).toString() }), RESOURCE, "k")).toThrow(/per-call/);
  });
  it("refuses once the cumulative cap is reached", () => {
    const g = guard({ maxTotalRaw: xnoToRaw("0.0015") });
    g.authorize(quote(), RESOURCE, "a").commit();
    expect(() => g.authorize(quote(), RESOURCE, "b")).toThrow(/cumulative/);
  });
  it("never authorizes a second block for the same request, including concurrent", () => {
    const g = guard({ maxTotalRaw: xnoToRaw("1") });
    g.authorize(quote(), RESOURCE, "same");
    expect(() => g.authorize(quote(), RESOURCE, "same")).toThrow(/already paid/);
  });
  it("refuses a quote whose resource url leaves the request origin", () => {
    const q = quote();
    q.required.resource.url = "https://evil.example/pay";
    expect(() => guard().authorize(q, RESOURCE, "k")).toThrow(/cross_origin/);
  });
  it("refuses a stale quote", () => {
    const now = 1_000_000;
    const g = guard({ now: () => now + 61_000 });
    expect(() => g.authorize(quote({}, now), RESOURCE, "k")).toThrow(/stale/);
  });
  it("refuses malformed amounts, assets and payees", () => {
    for (const over of [
      { amount: "1.5" },
      { amount: "0" },
      { asset: "ETH" },
      { payTo: "not-a-nano-address" },
      { scheme: "upto" },
    ] as Partial<Accepted>[]) {
      expect(() => guard().authorize(quote(over), RESOURCE, "k")).toThrow(GuardRefusal);
    }
  });
  it("fails closed on an empty allowlist", () => {
    expect(() => guard({ payToAllowlist: [] })).toThrow();
  });
});