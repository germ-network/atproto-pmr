import type {
    PairMailboxKey,
    SenderHold,
    SettledSenderDeclaration,
} from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "./env"

/**
 * `PairPutDeps.senderHold` over the `SENDER_HOLDS` namespace, one object per
 * sender DID. Undefined with no namespace bound, so the pair-put path keeps
 * answering `409`.
 */
export function senderHolds(
    env: Pick<PMREnv, "SENDER_HOLDS">
): ((senderDID: PairMailboxKey) => SenderHold) | undefined {
    void env
    throw new Error("senderHolds: not implemented")
}

/**
 * For a deployment's monitor `onSettled`: forwards the settle to that
 * sender's hold. Never throws, so a hold fault cannot fail the monitor's
 * settle; with no namespace bound it does nothing.
 */
export async function releaseSenderHold(
    env: Pick<PMREnv, "SENDER_HOLDS">,
    senderDID: string,
    settled: SettledSenderDeclaration | null,
    nowSeconds: number
): Promise<void> {
    void env
    void senderDID
    void settled
    void nowSeconds
    throw new Error("releaseSenderHold: not implemented")
}
