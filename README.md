# langchain-x402-nano

A LangChain tool that pays [Nano (XNO)](https://nano.org) `x402` **`exact`** quotes on `nano:mainnet`, behind a payment guard that runs before anything is signed.

- **Tool** `nano_x402_fetch`: fetch a URL; if the resource answers `402` with a Nano exact quote, pay it from the operator's capped Nano account, then return the response body plus the send-block hash.
- Signature: `createNanoX402Tool(config)` → `DynamicStructuredTool` with an `{ url, method?, body? }` schema.
- Pinned to `@langchain/core` **1.3.2**. Uses [`nanocurrency`](https://www.npmjs.com/package/nanocurrency) 2.5.0 for the send block; the integration is the binding plus the guard, not the signing code.

## Guard (all checked before signing)

- Wrong network refused (default `nano:mainnet`).
- `payTo` outside `NANO_PAYTO_ALLOWLIST` refused; an empty allowlist fails closed when the tool is created.
- Amount above `NANO_MAX_PER_CALL` refused; cumulative spend above `NANO_MAX_TOTAL` for the tool's life refused.
- A second invocation for the same request never signs a second block (including concurrent calls).
- A redirect to another origin is never paid (same-origin redirects are followed on the unsigned probe only).
- Malformed quotes refused. The quote is used within `maxTimeoutSeconds`; an expired quote is refused and never re-used — fetch again.
- One send block per call; no automatic paid retry after a non-2xx. The same signed payload is re-presented only while the seller answers `X-Nano-Represent`.

## Install

```bash
npm install --ignore-scripts langchain-x402-nano @langchain/core@1.3.2
```

## One-call example

`example/pay.mjs` (this repository), against a real ₪0.001 resource:

```js
import { createNanoX402Tool } from "langchain-x402-nano";

const tool = createNanoX402Tool({
  payToAllowlist: ["nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue"], // pursekeeper.dev
  maxPerCallXno: "0.001",
  maxTotalXno: "0.01",
});

const out = await tool.invoke({
  url: "https://pursekeeper.dev/v1/fetch?url=https://example.com",
});
console.log(out); // {"status":200,"paid":true,"blockHash":"…","amountRaw":"1000000000000000000000000000","body":"…"}
```

```bash
NANO_SEED=<64-hex seed of a small, capped account> node example/pay.mjs
```

Override the target with `NANO_X402_URL`, and the payee allowlist / caps with `NANO_PAYTO_ALLOWLIST`, `NANO_MAX_PER_CALL`, `NANO_MAX_TOTAL`.

The signer reads the payer's frontier and balance from the seller's no-node `GET /v1/account_info` (or `NANO_RPC` if you pass `rpcUrl`), gets proof-of-work from `POST /v1/work` (or `workUrl`), and falls back to local CPU work. No node of your own is required. Work is skipped when the quote says `extra.workOptional`.

## Secrets

The package never contains, logs, prints or returns a seed or private key. `NANO_SEED` is read from the environment (or injected with `seed`); the seed stays inside the signer closure. Keep it out of prompts, character files and logs, and cap what the tool can spend before giving it a wallet.

## Tests

```bash
npm install --ignore-scripts && npm test
```

29 offline tests against a mocked 402 / mocked door: wrong network, `payTo` allowlist (including fail-closed empty), per-call and cumulative caps, no second block (including concurrent), cross-origin redirect never paid, malformed quote, stale quote refused (including expiry during signing), no paid retry after non-2xx, same-payload re-presentation only while `X-Nano-Represent` is present, LangChain tool wiring (schema, one payment per request, cap refusal before signing, seed never in output).

## Licence

MIT