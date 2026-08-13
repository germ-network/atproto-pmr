import {
    base64URLToBinary,
    binaryToBase64URL,
    type Directory,
    type Locator,
    type PMRStore,
    type RegistrationFields,
    type ResolvedAddress,
} from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "./env"
import type { PMRObject } from "./pmr-object"

/** Minimum TTL Cloudflare KV accepts, seconds. Below this it errors. */
const MIN_KV_TTL_SECONDS = 60

interface GrantAddressRow {
    locator: string
    /** Base64url — `KVNamespace` JSON values are not typed for raw bytes. */
    authKey: string
    closed?: boolean
    expiresAt: number
}

function ttlFor(expiresAt: number): number {
    return Math.max(MIN_KV_TTL_SECONDS, Math.floor(expiresAt - Date.now() / 1000))
}

/**
 * KV-backed directory. Global, small, read on every inbound request.
 *
 * A relational adapter would make this a table; nothing about the seam
 * assumes a key-value store.
 */
export class KVDirectory<TPMR extends PMRObject = PMRObject>
    implements Directory
{
    constructor(private readonly env: PMREnv<TPMR>) {}

    async resolve(did: string): Promise<Locator | null> {
        return (await this.env.pmrDirectory.get(did)) ?? null
    }

    /**
     * CONSISTENCY CONTRACT (5): uniform cost.
     *
     * The `closed` flag lives in the stored value rather than being encoded
     * by the row's presence or absence, so a live address, a closed one,
     * and one that never existed all cost the same single lookup. Storing
     * closed addresses in a second namespace, or returning early before a
     * later step, would leak blocking through latency even though the
     * response bytes are identical.
     *
     * Callers MUST treat `closed` as "answer `202` and store nothing",
     * never as "return early".
     */
    async resolveAddress(address: string): Promise<ResolvedAddress | null> {
        const raw = await this.env.addresses.get(address, "json")
        if (raw === null) return null
        const row = raw as GrantAddressRow
        return {
            locator: row.locator,
            closed: row.closed === true,
            authKey: base64URLToBinary(row.authKey),
        }
    }

    /**
     * The global routing row a grant put resolves against. `expiresAt` is
     * stored in the row AND drives the KV entry's own TTL: the TTL is what
     * keeps an expired grant and one that never existed costing the same
     * lookup once it lapses (CONSISTENCY CONTRACT (5), same as `closed`),
     * and the stored copy is what lets `setGrantAddressClosed` re-apply the
     * same TTL on an update rather than resetting or dropping it — Workers
     * KV has no "read the current TTL back" call, only `expirationTtl` on
     * write.
     */
    async createGrantAddress(
        locator: Locator,
        address: string,
        authKey: Uint8Array,
        expiresAt: number
    ): Promise<void> {
        const row: GrantAddressRow = {
            locator,
            authKey: binaryToBase64URL(authKey),
            expiresAt,
        }
        await this.env.addresses.put(address, JSON.stringify(row), {
            expirationTtl: ttlFor(expiresAt),
        })
    }

    /** Rewrites the row with `closed` flipped, preserving its own TTL. */
    async setGrantAddressClosed(address: string, closed: boolean): Promise<void> {
        const raw = await this.env.addresses.get(address, "json")
        if (raw === null) return
        const row = raw as GrantAddressRow
        await this.env.addresses.put(
            address,
            JSON.stringify({ ...row, closed } satisfies GrantAddressRow),
            { expirationTtl: ttlFor(row.expiresAt) }
        )
    }

    async deleteGrantAddress(address: string): Promise<void> {
        await this.env.addresses.delete(address)
    }

    /** Idempotent on DID. */
    async create(
        did: string,
        registration: RegistrationFields
    ): Promise<Locator> {
        const existing = await this.resolve(did)
        if (existing !== null) return existing

        const id = this.env.pmrs.newUniqueId()
        const locator = id.toString()
        await this.env.pmrDirectory.put(did, locator)
        await this.env.pmrs.get(id).update(registration)
        return locator
    }

    async delete(did: string): Promise<void> {
        await this.env.pmrDirectory.delete(did)
    }
}

/**
 * Reach one relay's store from its locator.
 *
 * The Durable Object stub satisfies `PMRStore` directly: its RPC methods
 * have the same names and shapes as the interface, which is why the
 * interface uses `append`/`list`/`remove` rather than storage-flavored
 * names.
 */
export function pmrStore<TPMR extends PMRObject>(
    locator: Locator,
    env: PMREnv<TPMR>
): PMRStore {
    return env.pmrs.get(env.pmrs.idFromString(locator)) as unknown as PMRStore
}

/** A `BodyStore` over a KV namespace, with native TTL for expiry. */
export function kvBodyStore<TPMR extends PMRObject>(env: PMREnv<TPMR>) {
    return {
        async putBody(id: string, bytes: Uint8Array, expiresAt: number) {
            const ttl = Math.max(60, Math.floor(expiresAt - Date.now() / 1000))
            await env.messages.put(id, bytes, { expirationTtl: ttl })
        },
        async getBody(id: string): Promise<Uint8Array | null> {
            const v = await env.messages.get(id, "arrayBuffer")
            return v === null ? null : new Uint8Array(v)
        },
        async deleteBody(id: string) {
            await env.messages.delete(id)
        },
    }
}
