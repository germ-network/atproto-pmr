import type {
    HoldAdmission,
    HoldRequest,
    PairMailboxKey,
    ReleaseSummary,
    SenderHold,
    SettledSenderDeclaration,
} from "@germ-network/atproto-pmr-core"
import type { PMREnv } from "./env"
import { errorKind } from "./log-safe"

/** The RPC surface of `SenderHoldObject`. */
interface SenderHoldStub {
    admit(senderDID: string, request: HoldRequest): Promise<HoldAdmission>
    settle(
        senderDID: string,
        settled: SettledSenderDeclaration | null,
        nowSeconds: number
    ): Promise<ReleaseSummary>
}

function holdFor(namespace: DurableObjectNamespace, senderDID: string): SenderHoldStub {
    return namespace.get(namespace.idFromName(senderDID)) as unknown as SenderHoldStub
}

/**
 * `PairPutDeps.senderHold` over the `SENDER_HOLDS` namespace, one object per
 * sender DID. Undefined with no namespace bound, so the pair-put path keeps
 * answering `409`.
 */
export function senderHolds(
    env: Pick<PMREnv, "SENDER_HOLDS">
): ((senderDID: PairMailboxKey) => SenderHold) | undefined {
    const namespace = env.SENDER_HOLDS
    if (namespace === undefined) return undefined
    return (senderDID) => ({
        admit: (request) => holdFor(namespace, senderDID).admit(senderDID, request),
    })
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
    const namespace = env.SENDER_HOLDS
    if (namespace === undefined) return
    try {
        await holdFor(namespace, senderDID).settle(senderDID, settled, nowSeconds)
    } catch (err) {
        console.warn("releaseSenderHold: settle failed", errorKind(err))
    }
}
