/** The UTC day number of a time in seconds; non-finite for a non-finite input, which never compares as a later day. */
export function utcDay(seconds: number): number {
    return Math.floor(seconds / 86_400)
}
