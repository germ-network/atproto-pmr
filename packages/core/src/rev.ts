/**
 * Comparing atproto repo revisions.
 *
 * A `rev` is a TID — lexicographically sortable, so ordering needs no parsing.
 * This is the single definition both the key monitor's `rev` index
 * (`packages/monitor`) and the relay's own-DID declaration watch (`watch.ts`)
 * compare against, so the two cannot drift on what "newer" means.
 */
export type RevComparison = "unchanged" | "advanced" | "regressed"

export function compareRev(indexed: string | null, observed: string): RevComparison {
    if (indexed === null || indexed === observed) {
        return indexed === null ? "advanced" : "unchanged"
    }
    return observed > indexed ? "advanced" : "regressed"
}
