/**
 * Accumulates process output for the host, keeping only the most recent
 * `limit` characters.
 *
 * A cap is required, not defensive: the captured text crosses the page/host
 * boundary in one piece, and an `npm install` on a large project emits far more
 * than anyone wants serialized. The **tail** is kept rather than the head
 * because the reason a caller wants the output is almost always a failure, and
 * failures report themselves at the end.
 *
 * Truncation is always reported — silently returning a prefix of the output as
 * if it were the whole thing is exactly the kind of quiet lie this codebase
 * keeps getting bitten by.
 */
export class OutputBuffer {
  private chunks: string[] = []
  private length = 0
  private dropped = 0

  /** @param limit Maximum characters to retain. Must be positive. */
  constructor(private readonly limit: number) {
    if (limit <= 0)
      throw new Error(`OutputBuffer limit must be > 0, got ${limit}`)
  }

  /** Appends a chunk, evicting the oldest characters once over the limit. */
  push(chunk: string): void {
    if (!chunk) return

    this.chunks.push(chunk)
    this.length += chunk.length

    while (this.length > this.limit) {
      const overflow = this.length - this.limit
      const oldest = this.chunks[0]

      if (oldest.length <= overflow) {
        this.chunks.shift()
        this.length -= oldest.length
        this.dropped += oldest.length
        continue
      }

      this.chunks[0] = oldest.slice(overflow)
      this.length -= overflow
      this.dropped += overflow
    }
  }

  /** The retained output, oldest retained character first. */
  get text(): string {
    return this.chunks.join('')
  }

  /** How many characters were evicted. `0` means nothing was lost. */
  get droppedChars(): number {
    return this.dropped
  }

  /** Whether anything was evicted — i.e. whether {@link text} is partial. */
  get truncated(): boolean {
    return this.dropped > 0
  }
}
