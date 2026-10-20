import {
    base64URLToBinary,
    binaryToBase64URL,
    type Directory,
    type Locator,
    type MonitorRegistrationNotify,
    type PMRStore,
    type RegistrationFields,
    type RegistrationSet,
    INACTIVE_BACKLOG_RETENTION_SECONDS,
    MAX_INACTIVE_REGISTRATIONS,
    type ResolvedAddress,
    parseOkpEd25519Key,
    thumbprintOkpEd25519,
} from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "./env"
import type { PMRObject } from "./pmr-object"

/** Minimum TTL Cloudflare KV accepts, seconds. Below this it errors. */
const MIN_KV_TTL_SECONDS = 60

/** The DID's row: one active registration and its inactive ones, newest first. */
interface DirectoryRow {
    a?: { l: Locator }
    i: Array<{
        l: Locator
        /** The anchor `COSE_Key`, base64url. */
        k: string
        at: number
        until: number
    }>
}

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
    constructor(
        private readonly env: PMREnv<TPMR>,
        private readonly lifecycle: {
            inactiveRetentionSeconds: number
            maxInactive: number
        } = {
            inactiveRetentionSeconds: INACTIVE_BACKLOG_RETENTION_SECONDS,
            maxInactive: MAX_INACTIVE_REGISTRATIONS,
        }
    ) {}

    async resolve(did: string): Promise<Locator | null> {
        return (await this.readRow(did)).a?.l ?? null
    }

    /** A bare locator string is a row written before registration sets: one active registration. */
    private async readRow(did: string): Promise<DirectoryRow> {
        const raw = await this.env.pmrDirectory.get(did)
        if (raw === null) return { i: [] }
        if (!raw.startsWith("{")) return { a: { l: raw }, i: [] }
        const row = JSON.parse(raw) as Partial<DirectoryRow>
        return { a: row.a, i: row.i ?? [] }
    }

    private async writeRow(did: string, row: DirectoryRow): Promise<void> {
        if (row.a === undefined && row.i.length === 0) {
            await this.env.pmrDirectory.delete(did)
            return
        }
        await this.env.pmrDirectory.put(did, JSON.stringify(row))
    }

    private async destroyQuietly(locator: Locator, did: string): Promise<void> {
        try {
            await this.env.pmrs.get(this.env.pmrs.idFromString(locator)).destroy()
        } catch (err) {
            console.warn(`KVDirectory: DO teardown failed for ${did}:`, err)
        }
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

    /** Idempotent on the active registration; the inactive set is kept. */
    async create(
        did: string,
        registration: RegistrationFields
    ): Promise<Locator> {
        const row = await this.readRow(did)
        if (row.a !== undefined) {
            await this.notifyMonitor("register", did)
            return row.a.l
        }

        const id = this.env.pmrs.newUniqueId()
        const locator = id.toString()
        await this.writeRow(did, { a: { l: locator }, i: row.i })
        await this.env.pmrs.get(id).update(registration)
        await this.notifyMonitor("register", did)
        return locator
    }

    async registrations(did: string, nowSeconds: number): Promise<RegistrationSet> {
        const row = await this.readRow(did)
        return {
            active: row.a?.l ?? null,
            inactive: row.i
                .filter((e) => e.until > nowSeconds)
                .map((e) => ({
                    locator: e.l,
                    anchorKey: base64URLToBinary(e.k),
                    inactiveAt: e.at,
                    destroyAt: e.until,
                })),
        }
    }

    async deactivate(
        did: string,
        nowSeconds: number,
        expectedActive: Locator
    ): Promise<Locator | null> {
        const row = await this.readRow(did)
        if (row.a === undefined || row.a.l !== expectedActive) return null
        const locator = row.a.l
        const until = nowSeconds + this.lifecycle.inactiveRetentionSeconds

        const store = this.env.pmrs.get(this.env.pmrs.idFromString(locator))
        const fields = await store.load()
        await store.markInactive(nowSeconds, until)
        // A retried deactivate keeps the object's first times; the row follows.
        const marked = (await store.readInactive()) ?? { inactiveAt: nowSeconds, destroyAt: until }

        const live = row.i.filter((e) => e.until > nowSeconds)
        if (fields !== null) {
            live.unshift({
                l: locator,
                k: binaryToBase64URL(fields.anchorKey),
                at: marked.inactiveAt,
                until: marked.destroyAt,
            })
        }
        const evicted = live.splice(this.lifecycle.maxInactive)
        await this.writeRow(did, { i: live })
        for (const e of evicted) await this.destroyQuietly(e.l, did)
        if (fields === null) await this.destroyQuietly(locator, did)

        await this.notifyMonitor("unregister", did)
        return locator
    }

    async deregister(did: string, anchorThumbprint: Uint8Array): Promise<void> {
        const row = await this.readRow(did)
        if (row.a === undefined) return
        const locator = row.a.l
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
        await this.writeRow(did, { i: row.i })
        await this.destroyQuietly(locator, did)
        await this.notifyMonitor("unregister", did)
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
