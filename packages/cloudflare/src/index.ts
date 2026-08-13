/**
 * `@germ-network/atproto-pmr-cloudflare` — a Durable-Object and KV
 * implementation of the storage seam in `@germ-network/atproto-pmr-core`.
 *
 * `@germ-network/atproto-pmr-core` is a **peer** dependency: install it
 * yourself, from the same source as this package, so there is exactly one
 * copy and the types unify.
 *
 * A consuming Worker MUST re-export `PMRObject` from its own entry point,
 * because wrangler looks for the Durable Object class on `main`:
 *
 *     export { PMRObject } from "@germ-network/atproto-pmr-cloudflare"
 *
 * To use your own synthetic behavior — which you should, and should not
 * publish — subclass it:
 *
 *     export class MyPMR extends PMRObject {
 *         protected synthetic = MY_BEHAVIOR
 *     }
 *
 * `PMRObject.fetch` serves `GET /pmr/v1/events` and authenticates nothing:
 * it accepts any upgrade request reaching it and drains that relay's
 * backlog. A router MUST verify the RFC 9421 signature over the upgrade
 * request (`authenticateOwner`) and resolve the stub from the
 * authenticated DID, never from what the request names, before forwarding.
 *
 * `ctx.acceptWebSocket` runs only inside the Durable Object, while the
 * challenge store and directory a signature is checked against belong to
 * the deployment.
 */

export { PMRObject } from "./pmr-object"
export { KVDirectory, pmrStore, kvBodyStore } from "./directory"
export { kvChallengeStore } from "./challenge-store"
export type { PMREnv } from "./env"
