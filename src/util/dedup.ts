/**
 * LRU-based dedup set. `check(id)` returns true if the id was already
 * present (and promotes it to MRU), false if the id is new (and inserts it).
 */
export class LruDedup {
  private readonly capacity: number;
  private readonly map = new Map<string, true>();

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error("LruDedup capacity must be > 0");
    this.capacity = capacity;
  }

  check(id: string): boolean {
    if (this.map.has(id)) {
      // Promote to MRU by re-inserting.
      this.map.delete(id);
      this.map.set(id, true);
      return true;
    }
    this.map.set(id, true);
    if (this.map.size > this.capacity) {
      // Evict the least recently used (first key in insertion order).
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return false;
  }

  size(): number {
    return this.map.size;
  }
}
