// Imported statically by both lazily-loaded features, so the bundler emits it
// as a shared chunk that the feature chunks depend on.
export function sharedValue(): string {
  return 'LAZY_CHUNK_LOADED'
}
