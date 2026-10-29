import { describe, expect, it, vi } from "vitest";
import { createNanoX402Tool } from "../src/tool.js";

// Deterministic test seed. Never use this for anything real.
const TEST_SEED = "22".repeat(32);
const PAY_TO = "nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue";
const PAYER = "nano_39qcg8g856n7r7r4ruxbaftybed6qk7fb9wywa9uefjodp5548mwoyeojfxb";
const RESOURCE = "https://pursekeeper.dev/v1/fetch?url=https://example.com";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

function quote(amount = "1000000000000000000000000000") {
  return {
    x402Version: 2,
    resource: { url: RESOURCE },
    accepts: [
      {
        scheme: "exact",
        network: "nano:mainnet",
        amount,
        asset: "XNO",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { workOptional: true },
      },
    ],
  };
}

/** Mock network: the target 402s, the door answers account_info and work, the paid retry is 200. */
function doorFetch(targetStatus = 200) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://pursekeeper.dev/v1/account_info")) {
      return new Response(
        JSON.stringify({ found: true, frontier: "ab".repeat(32), balance_raw: "100000000000000000000000000000", representative: PAYER }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === "https://pursekeeper.dev/v1/work") {
      return new Response(JSON.stringify({ work: "ffffffffffffffff" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (init?.headers && (init.headers as Record<string, string>)["payment-signature"]) {
      return new Response(JSON.stringify({ ok: true, status: targetStatus }), { status: targetStatus, headers: { "content-type": "application/json" } });
    }
    return new Response("payment required", { status: 402, headers: { "payment-required": b64(quote()) } });
  });
}

describe("createNanoX402Tool", () => {
  it("is a LangChain structured tool", () => {
    const tool = createNanoX402Tool({ seed: TEST_SEED, payToAllowlist: [PAY_TO], fetch: doorFetch() });
    expect(tool.name).toBe("nano_x402_fetch");
    expect(typeof tool.description).toBe("string");
    expect(tool.schema).toBeTruthy();
  });

  it("pays one block and returns the body with the hash, without leaking the seed", async () => {
    const tool = createNanoX402Tool({
      seed: TEST_SEED,
      payToAllowlist: [PAY_TO],
      maxPerCallXno: "0.001",
      maxTotalXno: "0.01",
      fetch: doorFetch(),
    });
    const out = await tool.invoke({ url: RESOURCE });
    const parsed = JSON.parse(out as string);
    expect(parsed).toMatchObject({ status: 200, paid: true });
    expect(parsed.blockHash).toMatch(/^[0-9a-fA-F]{64}$/);
    expect(parsed.amountRaw).toBe("1000000000000000000000000000");
    expect(JSON.stringify(out)).not.toContain(TEST_SEED);
  });

  it("refuses a second call for the same request without paying twice", async () => {
    const tool = createNanoX402Tool({ seed: TEST_SEED, payToAllowlist: [PAY_TO], fetch: doorFetch() });
    await tool.invoke({ url: RESOURCE });
    await expect(tool.invoke({ url: RESOURCE })).rejects.toThrow(/already paid/);
  });

  it("refuses a quote above the per-call cap before signing", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://pursekeeper.dev/v1/account_info")) return new Response("{}", { status: 500 });
      if (url === "https://pursekeeper.dev/v1/work") return new Response("{}", { status: 500 });
      if (init?.headers && (init.headers as Record<string, string>)["payment-signature"]) return new Response("", { status: 200 });
      return new Response("payment required", { status: 402, headers: { "payment-required": b64(quote("5000000000000000000000000000")) } });
    });
    const tool = createNanoX402Tool({ seed: TEST_SEED, payToAllowlist: [PAY_TO], maxPerCallXno: "0.001", fetch });
    await expect(tool.invoke({ url: RESOURCE })).rejects.toThrow(/per-call/);
    expect(fetch).toHaveBeenCalledTimes(1); // only the unsigned probe
  });

  it("fails closed without an allowlist or a seed", () => {
    expect(() => createNanoX402Tool({ seed: TEST_SEED, fetch: doorFetch() })).toThrow(/allowlist/i);
    expect(() =>
      createNanoX402Tool({ payToAllowlist: [PAY_TO], seed: "", fetch: doorFetch() })
    ).toThrow();
  });

  it("refuses a payee outside the allowlist", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith("https://pursekeeper.dev/v1/account_info")) return new Response("{}", { status: 500 });
      return new Response("payment required", { status: 402, headers: { "payment-required": b64(quote()) } });
    });
    const tool = createNanoX402Tool({ seed: TEST_SEED, payToAllowlist: ["nano_1111111111111111111111111111111111111111111111111111hifc8npp"], fetch });
    await expect(tool.invoke({ url: RESOURCE })).rejects.toThrow(/allowlist/i);
  });
});