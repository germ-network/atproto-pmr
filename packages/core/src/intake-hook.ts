/**
 * Calls a deployment's `onIntakeStored` observer without letting it affect
 * the intake: a synchronous throw or a rejection is swallowed, and the result
 * is deferred rather than awaited so a slow observer delays nothing.
 */
export function notifyIntakeStored(
    hook: ((acceptedAtS: number) => Promise<unknown> | void) | undefined,
    defer: (work: Promise<unknown>) => void,
    acceptedAtS: number
): void {
    if (hook === undefined) return
    try {
        defer(Promise.resolve(hook(acceptedAtS)).catch(() => {}))
    } catch {}
}
