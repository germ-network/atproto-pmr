import {
    base64URLToBinary,
    binaryToBase64URL,
    type Directory,
    type Locator,
    type MonitorRegistrationNotify,
    type PMRStore,
    type RegistrationFields,
    type ResolvedAddress,
    parseOkpEd25519Key,
    thumbprintOkpEd25519,
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

/** Write-once: a tombstone is never rewritten or removed. */
function tombstoneKey(did: string, anchorThumbprint: Uint8Array): string {
    return `tomb:${did}:${binaryToBase64URL(anchorThumbprint)}`
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

    /**
     * Tells a bound monitor about a directory write, after the write. Never
     * throws: a registration must not fail because the monitor is down. A
     * monitor that hangs rather than fails delays the write; there is no timeout.
     */
    private async notifyMonitor(
        call: keyof MonitorRegistrationNotify,
        did: string
    ): Promise<void> {
        const { MONITOR_INGEST, MONITOR_INGEST_NAME } = this.env
        if (MONITOR_INGEST === undefined || MONITOR_INGEST_NAME === undefined) return
        try {
            const monitor = MONITOR_INGEST.get(
                MONITOR_INGEST.idFromName(MONITOR_INGEST_NAME)
            ) as unknown as MonitorRegistrationNotify
            await monitor[call](did)
        } catch (err) {
            console.warn(`KVDirectory.${call}: monitor notify failed for ${did}:`, err)
        }
    }

    /** Idempotent on DID. */
    async create(
        did: string,
        registration: RegistrationFields
    ): Promise<Locator> {
        const existing = await this.resolve(did)
        if (existing !== null) {
            await this.notifyMonitor("register", did)
            return existing
        }

        const id = this.env.pmrs.newUniqueId()
        const locator = id.toString()
        await this.env.pmrDirectory.put(did, locator)
        await this.env.pmrs.get(id).update(registration)
        await this.notifyMonitor("register", did)
        return locator
    }

    /** Unlinks the DID, then tears down the DO's storage — best-effort. */
    async delete(did: string): Promise<void> {
        const locator = await this.resolve(did)
        if (locator === null) return
        await this.unlinkAndDestroy(did, locator)
    }

    async retire(did: string, expectedActive: Locator): Promise<Locator | null> {
        if ((await this.resolve(did)) !== expectedActive) return null
        await this.unlinkAndDestroy(did, expectedActive)
        return expectedActive
    }

    /**
     * Raised once per registration removed: replace, retire and deregister
     * all pass through here. `locator` names the removed registration, so a
     * late call can be told apart from a newer registration of the same DID.
     * Runs after the unlink; a throw is logged and swallowed, so a deployment
     * index keyed to it must tolerate a missed call (re-check on use).
     */
    protected async onRemoved(_did: string, _locator: Locator): Promise<void> {}

    private async unlinkAndDestroy(did: string, locator: Locator): Promise<void> {
        // Unlink first: this is the authoritative step. A crash between here and the
        // teardown below degrades to an orphaned-but-intact DO, never to a routing
        // row pointing at a half-wiped DO.
        await this.env.pmrDirectory.delete(did)
        try {
            await this.env.pmrs.get(this.env.pmrs.idFromString(locator)).destroy()
        } catch (err) {
            // Best-effort reclamation: a failed teardown just leaves the orphan, it
            // must not fail the deregistration/replace.
            console.warn(`KVDirectory: DO teardown failed for ${did}:`, err)
        }
        try {
            await this.onRemoved(did, locator)
        } catch (err) {
            console.warn(`KVDirectory: onRemoved failed for ${did}:`, err)
        }
        await this.notifyMonitor("unregister", did)
    }

    async deregister(did: string, anchorThumbprint: Uint8Array): Promise<void> {
        const locator = await this.resolve(did)
        if (locator === null) return
        const fields = await this.env.pmrs
            .get(this.env.pmrs.idFromString(locator))
            .load()
        if (
            fields === null ||
            binaryToBase64URL(thumbprintOkpEd25519(parseOkpEd25519Key(fields.anchorKey))) !==
                binaryToBase64URL(anchorThumbprint)
        ) {
            return
        }
        // The tombstone is written before the registration goes: a crash in
        // between leaves it active-but-tombstoned until the DELETE is retried.
        const key = tombstoneKey(did, anchorThumbprint)
        if ((await this.env.pmrDirectory.get(key)) === null) {
            await this.env.pmrDirectory.put(key, "1")
        }
        await this.unlinkAndDestroy(did, locator)
    }

    async isTombstoned(did: string, anchorThumbprint: Uint8Array): Promise<boolean> {
        return (await this.env.pmrDirectory.get(tombstoneKey(did, anchorThumbprint))) !== null
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
