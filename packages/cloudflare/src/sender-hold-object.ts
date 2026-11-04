import { DurableObject } from "cloudflare:workers"
import type {
    AuthenticatedPutDeps,
    HoldAdmission,
    HoldRequest,
    ReleaseSummary,
    SenderDeclarationResolution,
    SettledSenderDeclaration,
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
 * Abstract because reading the sender's PDS and storing into a recipient's
 * mailbox both need deployment wiring (fetch, signing-key cache, directory,
 * admission). A deployment subclasses it and re-exports the subclass from
 * its own `main`.
 */
export abstract class SenderHoldObject extends DurableObject<PMREnv> {
    /** The sender's declaration from its PDS, typically `directDeclarationResolver`. */
    protected abstract readDirect(senderDID: string): Promise<SenderDeclarationResolution>

    /** Where a release stores, as the deployment's pair-put path does. `releaseHeld` awaits whatever it defers. */
    protected abstract releaseDeps(): AuthenticatedPutDeps

    /** Held-put cap for one sender; `MAX_MESSAGES_PER_PAIR_SENDER` by default. */
    protected maxHeld(): number {
        return parseInt(this.env.MAX_MESSAGES_PER_PAIR_SENDER)
    }

    /** `SenderHold.admit` for `senderDID`; arms the expiry alarm when it holds a put. */
    async admit(senderDID: string, request: HoldRequest): Promise<HoldAdmission> {
        void senderDID
        void request
        throw new Error("SenderHoldObject.admit: not implemented")
    }

    /** The monitor settled `settled` for `senderDID` (`null`: disposed). Re-arms or clears the alarm. */
    async settle(
        senderDID: string,
        settled: SettledSenderDeclaration | null,
        nowSeconds: number
    ): Promise<ReleaseSummary> {
        void senderDID
        void settled
        void nowSeconds
        throw new Error("SenderHoldObject.settle: not implemented")
    }

    /** Drops expired holds and re-arms for the earliest remaining expiry. */
    async alarm(): Promise<void> {
        throw new Error("SenderHoldObject.alarm: not implemented")
    }
}
