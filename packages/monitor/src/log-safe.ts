const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/**
 * A bounded label for a caught value, for logs. Only the class name: an
 * error's message or stack can carry a DID, a URL or a response body.
 */
export function errorKind(err: unknown): string {
    return err instanceof Error ? boundedErrorName(err.name) : typeof err
}

/** An error name already captured as text, held to the same bound. */
export function boundedErrorName(name: string): string {
    return NAME.test(name) ? name : "Error"
}
