import type { FollowEdgeWriter } from "@germ-network/atproto-pmr-monitor"

/**
 * What one committed write changed, as far as owner summaries go.
 *
 * `dids` changed their own standing (a declaration settled or went, a DID
 * started or stopped being an owner, holder or interest member), so every
 * owner whose summary covers them is affected: their followers, the accounts
 * they follow, and themselves. `owners` are affected directly and are not
 * expanded: an edge's effect on a summary stops at its two endpoints.
 */
export interface SummaryInputsChange {
    dids: readonly string[]
    owners: readonly string[]
}

/**
 * The graph owners whose summary `change` may have altered: followers of
 * `dids`, the subjects `dids` follow, `dids` themselves and `owners`,
 * restricted to `graph_owners`. One indexed statement per chunk of DIDs,
 * sorted and without duplicates.
 */
export async function summaryOwnersAffected(
    db: D1Database,
    change: SummaryInputsChange
): Promise<string[]> {
    const items = [
        ...change.dids.map((did) => ({ did, direct: false })),
        ...change.owners.map((did) => ({ did, direct: true })),
    ]
    const found = new Set<string>()
    for (let i = 0; i < items.length; i += D1_BIND_LIMIT) {
        const chunk = items.slice(i, i + D1_BIND_LIMIT)
        const dids = chunk.filter((item) => !item.direct).map((item) => item.did)
        const owners = chunk.filter((item) => item.direct).map((item) => item.did)
        const didList = placeholders(dids.length, 1)
        const members: string[] = []
        if (dids.length > 0) {
            members.push(
                `SELECT follower FROM follows WHERE subject IN (${didList})`,
                `SELECT subject FROM follows WHERE follower IN (${didList})`,
                `VALUES ${valuesList(dids.length, 1)}`
            )
        }
        if (owners.length > 0) {
            members.push(`VALUES ${valuesList(owners.length, dids.length + 1)}`)
        }
        const rows = await db
            .prepare(`SELECT did FROM graph_owners WHERE did IN (${members.join(" UNION ")})`)
            .bind(...dids, ...owners)
            .all<{ did: string }>()
        for (const row of rows.results) found.add(row.did)
    }
    return [...found].sort()
}

/** D1 allows 100 bound parameters per statement. */
const D1_BIND_LIMIT = 100

const placeholders = (count: number, from: number): string =>
    Array.from({ length: count }, (_, i) => `?${from + i}`).join(",")

const valuesList = (count: number, from: number): string =>
    Array.from({ length: count }, (_, i) => `(?${from + i})`).join(",")

/**
 * `writer`, reporting each committed write's summary inputs to `report`
 * after its batch resolves. A write that changed nothing reports nothing,
 * and a `report` that throws is logged, never surfaced to the caller: the
 * write already committed, and the step that made it still has bookkeeping
 * to finish.
 */
export function summaryInputTracking(
    writer: FollowEdgeWriter,
    report: (change: SummaryInputsChange) => Promise<void>
): FollowEdgeWriter {
    const announce = async (dids: Iterable<string>, owners: Iterable<string>): Promise<void> => {
        const change = { dids: [...new Set(dids)], owners: [...new Set(owners)] }
        if (change.dids.length === 0 && change.owners.length === 0) return
        try {
            await report(change)
        } catch (error) {
            console.error("monitor: summary inputs report failed", error)
        }
    }
    return {
        ...writer,
        async putEdges(edges, gen) {
            const result = await writer.putEdges(edges, gen)
            await announce(
                [],
                result.changedEndpoints ?? [...edges.map((e) => e.follower), ...result.subjects]
            )
            return result
        },
        async deleteEdges(refs) {
            const result = await writer.deleteEdges(refs)
            await announce(
                [],
                result.changedEndpoints ?? [...refs.map((r) => r.follower), ...result.subjects]
            )
            return result
        },
        async sweep(follower, gen) {
            const result = await writer.sweep(follower, gen)
            if (result.subjects.length > 0) await announce([], [follower, ...result.subjects])
            return result
        },
        async pruneFollower(follower) {
            const result = await writer.pruneFollower(follower)
            if (result.subjects.length > 0) await announce([], [follower, ...result.subjects])
            return result
        },
        async mirror(transitions) {
            const result = await writer.mirror(transitions)
            await announce(
                transitions.map((t) => t.now.did),
                result.subjects
            )
            return result
        },
        listMirrored: (cursor, limit) => writer.listMirrored(cursor, limit),
        mirroredOf: (dids) => writer.mirroredOf(dids),
        followersOf: (subjects) => writer.followersOf(subjects),
    }
}
