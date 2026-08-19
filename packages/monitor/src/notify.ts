import {
    buildDeclarationPushPayload,
    type DeliverPushResult,
} from "@germ-network/atproto-pmr-core"
import type { MonitorRegistration, MonitorRegistrationStore } from "./registration.js"

/**
 * Own-DID push: `spec/key-transparency.md`, §Registration and the own-DID
 * push. Content-free and permanently so — see `buildDeclarationPushPayload`
 * — so this module's only job is finding the registered destination and
 * sending exactly `{t:"d"}` to it.
 *
 * Platform-neutral, like the rest of this package: no `fetch`, no
 * `console`. **Throws on a genuine delivery failure** (network error, a
 * malformed VAPID key) rather than swallowing it — the deployment adapter
 * (`packages/monitor-cloudflare`'s `ingest-object.ts`) decides what "never
 * reject" discipline applies at its own boundary, the same split
 * `packages/cloudflare`'s `push-sender.ts` / `pmr-object.ts` already use
 * for the PMR's own push.
 */
export interface DeclarationPushSender {
    send(
        subscription: MonitorRegistration["pushSubscription"],
        plaintext: Uint8Array
    ): Promise<DeliverPushResult>
}

export interface NotifyDeps {
    registrations: MonitorRegistrationStore
    sender: DeclarationPushSender
}

/**
 * No registration for `did` → no-op, silently, returning `null`: not every
 * watched DID has opted into push, and the digest remains the channel for
 * those that haven't.
 *
 * On `discard` (RFC 8030 404/410 — the push service no longer recognizes
 * the subscription), the registration is dropped. This is also how a
 * device that lost its anchor key eventually clears its own stranded
 * registration, freeing it to re-register under a rotated key — see
 * `registration-endpoint.ts`'s module comment, "The self-healing lockout".
 *
 * Returns the raw `DeliverPushResult` rather than swallowing it: a
 * `"failed"` outcome (e.g. a rotated VAPID key that no longer pairs) is a
 * base-wide-misconfiguration signal the caller needs to be able to log —
 * this module stays `console`-free by design, so logging is the deployment
 * adapter's job, not this one's.
 */
export async function pushDeclarationChange(
    did: string,
    deps: NotifyDeps
): Promise<DeliverPushResult | null> {
    const registration = await deps.registrations.load(did)
    if (registration === null) return null

    const plaintext = buildDeclarationPushPayload()
    const result = await deps.sender.send(registration.pushSubscription, plaintext)
    if (result.outcome === "discard") {
        await deps.registrations.delete(did)
    }
    return result
}
