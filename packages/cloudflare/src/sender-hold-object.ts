import { DurableObject } from "cloudflare:workers"
import {
    admitToHold,
    asPairMailboxKey,
    releaseHeld,
    sweepExpiredHolds,
    type AuthenticatedPutDeps,
    type HeldPairPut,
    type HoldAdmission,
    type HoldRequest,
    type InterimDeclaration,
    type PairMailboxKey,
    type ReleaseSummary,
    type SenderDeclarationResolution,
    type SenderHoldStorage,
    type SettledSenderDeclaration,
    type StoredSettledDeclaration,
} from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "./env"

/**
 * One Durable Object per sender DID (`idFromName(senderDID)`): the hold for
 * puts from a sender whose new declaration the monitor has not yet settled.
 * The input gate opens while a PDS read is in flight, so the object coalesces
 * concurrent reads through an in-memory promise rather than relying on
 * serialization. The first sender DID it serves is stored; a call naming
 * another is refused.
 *
 * Needs a SQLite-backed Durable Object (`new_sqlite_classes` in its
 * migration): a settled declaration's CAR is one stored value, which the
 * legacy backend's 128 KiB value limit would refuse.
 *
 * Abstract because reading the sender's PDS and storing into a recipient's
 * mailbox both need deployment wiring (fetch, signing-key cache, directory,
 * admission). A deployment subclasses it and re-exports the subclass from
 * its own `main`.
 */
export abstract class SenderHoldObject extends DurableObject<PMREnv> {
    private readonly holdStorage: SenderHoldStorage
    private inFlightRead: Promise<SenderDeclarationResolution> | null = null

    constructor(ctx: DurableObjectState, env: PMREnv) {
        super(ctx, env)
        this.holdStorage = objectHoldStorage(ctx.storage)
    }

    /** The sender's declaration from its PDS, typically `directDeclarationResolver`. */
    protected abstract readDirect(senderDID: string): Promise<SenderDeclarationResolution>

    /** Where a release stores, as the deployment's pair-put path does. `releaseHeld` awaits whatever it defers, except `onIntakeStored`, which goes to `defer` un-awaited: pass a real `waitUntil` or the release-time count is dropped. */
    protected abstract releaseDeps(): AuthenticatedPutDeps

    /** Held-put cap for one sender; `MAX_MESSAGES_PER_PAIR_SENDER` by default. */
    protected maxHeld(): number {
        return parseInt(this.env.MAX_MESSAGES_PER_PAIR_SENDER)
    }

    /** `SenderHold.admit` for `senderDID`; arms the expiry alarm when it holds a put. */
    async admit(senderDID: string, request: HoldRequest): Promise<HoldAdmission> {
        const key = await this.bind(senderDID)
        const admission = await admitToHold(request, {
            senderDID: key,
            storage: this.holdStorage,
            readDirect: (did) => this.coalescedRead(did),
            maxHeld: this.maxHeld(),
        })
        await this.arm(request.nowSeconds)
        return admission
    }

    /** The monitor settled `settled` for `senderDID` (`null`: disposed). Re-arms or clears the alarm. */
    async settle(
        senderDID: string,
        settled: SettledSenderDeclaration | null,
        nowSeconds: number
    ): Promise<ReleaseSummary> {
        const key = await this.bind(senderDID)
        const summary = await releaseHeld(
            settled,
            { ...this.releaseDeps(), senderDID: key, storage: this.holdStorage },
            nowSeconds
        )
        await this.arm(nowSeconds)
        return summary
    }

    /** Drops expired holds and re-arms for the earliest remaining expiry. */
    async alarm(): Promise<void> {
        await this.arm(Math.floor(Date.now() / 1000))
    }

    /** Sweeps, then arms the alarm for the earliest remaining expiry, or clears it. */
    private async arm(nowSeconds: number): Promise<void> {
        const next = await sweepExpiredHolds(this.holdStorage, nowSeconds)
        if (next === null) await this.ctx.storage.deleteAlarm()
        else await this.ctx.storage.setAlarm(next * 1000)
    }

    private async bind(senderDID: string): Promise<PairMailboxKey> {
        const key = asPairMailboxKey(senderDID)
        const bound = await this.ctx.storage.get<string>(SENDER_KEY)
        if (bound === undefined) await this.ctx.storage.put(SENDER_KEY, senderDID)
        else if (bound !== senderDID) throw new Error("sender hold: called for another sender")
        return key
    }

    private coalescedRead(senderDID: string): Promise<SenderDeclarationResolution> {
        this.inFlightRead ??= this.readDirect(senderDID)
            .catch((error): SenderDeclarationResolution => ({
                found: false,
                reason: `direct read failed: ${String(error)}`,
            }))
            .finally(() => {
                this.inFlightRead = null
            })
        return this.inFlightRead
    }
}

const SENDER_KEY = "sender"
const HELD_PREFIX = "held:"

/** `SenderHoldStorage` over a Durable Object's storage. Held puts are keyed by a padded sequence so `list` returns arrival order. */
function objectHoldStorage(storage: DurableObjectStorage): SenderHoldStorage {
    return {
        settled: async () => (await storage.get<StoredSettledDeclaration>("settled")) ?? null,
        setSettled: async (value) => {
            if (value === null) await storage.delete("settled")
            else await storage.put("settled", value)
        },
        interim: async () => (await storage.get<InterimDeclaration>("interim")) ?? null,
        setInterim: async (value) => {
            if (value === null) await storage.delete("interim")
            else await storage.put("interim", value)
        },
        lastDirectReadAt: async () => (await storage.get<number>("lastDirectReadAt")) ?? null,
        setLastDirectReadAt: (seconds) => storage.put("lastDirectReadAt", seconds),
        held: async () => [...(await storage.list<HeldPairPut>({ prefix: HELD_PREFIX })).values()],
        append: async (put) => {
            const seq = ((await storage.get<number>("heldSeq")) ?? 0) + 1
            await storage.put({
                heldSeq: seq,
                [`${HELD_PREFIX}${String(seq).padStart(12, "0")}`]: put,
            })
        },
        remove: async (nonceHexes) => {
            const doomed = [...(await storage.list<HeldPairPut>({ prefix: HELD_PREFIX })).entries()]
                .filter(([, put]) => nonceHexes.includes(put.nonceHex))
                .map(([key]) => key)
            if (doomed.length > 0) await storage.delete(doomed)
        },
    }
}
