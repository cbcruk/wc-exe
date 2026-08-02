/**
 * The running wc-exe version.
 *
 * Duplicated from package.json rather than imported, because importing JSON
 * would put package.json into the published bundle's module graph. The daemon
 * compares this against the version that started it — a mismatch means the
 * runner bundle on disk has moved under a daemon still serving the old one.
 */
export const VERSION = '0.1.1'
