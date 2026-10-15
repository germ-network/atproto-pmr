/**
 * The owner summary's per-contact "can I message this contact?" verdicts:
 * the owner as sender, each covered contact as recipient, computed by the
 * same rule as the public can-message route.
 */

import type { CanMessageVerdict, DeclaredPolicies, PolicySource } from "./can-message.js"
import { DECLARATION_COLLECTION_NSID } from "./declaration.js"
import type { SummaryHeldEntry, SummaryIndex } from "./summary.js"

/** One contact's verdict in a summary. */
export interface SummaryVerdict {
    did: string
    verdict: CanMessageVerdict
}

export const SUMMARY_VERDICT_KEYS = {
    did: "d",
    verdict: "v",
} as const satisfies { readonly [K in keyof SummaryVerdict]: string }

/**
 * A {@link PolicySource} over the summary's own index entries, so verdicts
 * need no read beyond the index: a held declaration with stored policies gives
 * them; one stored before policies were kept reads `unavailable`; a DID with
 * no held declaration answers null, so it gets no verdict. Takes only the
 * entries that are servable under rotation, those a {@link SummaryIndex}
 * keeps.
 */
export function indexPolicySource(entries: readonly SummaryHeldEntry[]): PolicySource {
    const declared = new Map<string, DeclaredPolicies>()
    for (const entry of entries) {
        if (entry.collection !== DECLARATION_COLLECTION_NSID || entry.rkey !== "self") continue
        declared.set(entry.did, entry.policies ?? { found: false, code: "unavailable" })
    }
    return { policiesOf: async (did) => declared.get(did) ?? null }
}
