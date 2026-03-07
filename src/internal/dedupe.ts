/**
 * Client-side deduplication for memory saves.
 *
 * Maintains a rolling window of recent saves and checks new text
 * against them using word-set Jaccard similarity.
 */

interface SaveEntry {
  words: Set<string>;
  timestamp: number;
}

/** Normalize and tokenize text into a word set for similarity comparison. */
function toWordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\[type:\w+\]/g, "")
      .replace(/\[importance:\w+\]/g, "")
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/** Jaccard similarity between two word sets (intersection / union). */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export class RecentSaves {
  private entries: SaveEntry[] = [];
  private readonly windowMs: number;
  private readonly similarityThreshold: number;

  constructor(windowMinutes: number, similarityThreshold = 0.7) {
    this.windowMs = windowMinutes * 60_000;
    this.similarityThreshold = similarityThreshold;
  }

  /** Prune entries older than the window. */
  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.entries = this.entries.filter((e) => e.timestamp >= cutoff);
  }

  /** Check if text is a near-duplicate of a recent save. */
  isDuplicate(text: string): boolean {
    this.prune();
    const words = toWordSet(text);
    if (words.size === 0) return false;
    for (const entry of this.entries) {
      if (jaccardSimilarity(words, entry.words) >= this.similarityThreshold) {
        return true;
      }
    }
    return false;
  }

  /** Record a save so future checks can detect duplicates. */
  record(text: string): void {
    this.prune();
    this.entries.push({ words: toWordSet(text), timestamp: Date.now() });
  }

  /** Number of entries currently in the window (for testing/stats). */
  get size(): number {
    this.prune();
    return this.entries.length;
  }
}
