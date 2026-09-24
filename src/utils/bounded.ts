/**
 * opencode-otel-plugin - Bounded Map Helpers
 *
 * Prevent unbounded growth of in-flight correlation maps
 * (parity with reference MAX_PENDING / setBoundedMap).
 */

export const MAX_PENDING = 500;

/**
 * Set a map entry with FIFO eviction when size exceeds max.
 * Returns true if an entry was evicted.
 */
export function setBoundedMap<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  max: number = MAX_PENDING
): boolean {
  map.set(key, value);
  if (map.size <= max) return false;

  // Evict oldest (insertion order)
  const oldest = map.keys().next();
  if (!oldest.done) {
    map.delete(oldest.value);
    return true;
  }
  return false;
}

/** Delete keys matching a predicate (session sweep). */
export function sweepMap<K, V>(
  map: Map<K, V>,
  predicate: (key: K, value: V) => boolean
): number {
  let removed = 0;
  for (const [key, value] of map) {
    if (predicate(key, value)) {
      map.delete(key);
      removed++;
    }
  }
  return removed;
}
