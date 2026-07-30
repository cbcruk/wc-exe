// Lives in a separate chunk. The marker below is asserted by the PoC harness to
// confirm the chunk was split out of the entry rather than inlined into it.
const MARKER = 'LAZY_CHUNK_LOADED'

export function lazyMessage(): string {
  return MARKER
}
