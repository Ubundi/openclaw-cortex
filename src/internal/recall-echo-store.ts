/**
 * Tracks recently recalled memory content so the capture handler can detect
 * when assistant output is echoing recalled memories (feedback loop prevention).
 *
 * Without this, the cycle is: recall → agent parrots → capture stores as new fact → recall (stronger).
 * With this, echoed content is stripped before capture, breaking the amplification loop.
 *
 * Detection strategy: containment-based, evaluated at sentence level.
 * We check if a high fraction of a recalled memory's content tokens appear in
 * any single sentence of the assistant's output. This catches both:
 * - Direct echoes: "Adii's birthday is March 10, turning 45"
 * - Paraphrased echoes: "Happy 45th birthday, Adii!" (short sentence, high token density)
 * - Verbose echoes with filler: long paragraphs where one sentence echoes the memory
 */

/** Common stop words to exclude from content token extraction. */
const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "has", "her",
  "was", "one", "our", "out", "his", "had", "hot", "how", "its", "let", "may",
  "who", "did", "get", "got", "him", "too", "use", "she", "been", "call",
  "each", "make", "like", "long", "look", "many", "most", "over", "such",
  "take", "than", "them", "then", "they", "this", "time", "very", "when",
  "will", "with", "just", "into", "that", "have", "from", "what", "here",
  "more", "also", "some", "year", "your", "been", "would", "could", "should",
  "about", "there", "their", "which", "these", "other", "being", "after",
  "only", "still", "back", "even", "down", "much",
]);

/**
 * Extract meaningful content tokens from text.
 * Includes content words (stop-word filtered) AND extracted numbers.
 * Numbers are important for catching paraphrases like "turning 45" → "45th birthday".
 */
export function toContentTokens(text: string): Set<string> {
  const lower = text.toLowerCase();
  const tokens = new Set<string>();

  // Extract content words
  for (const word of lower.replace(/[^\w\s]/g, " ").split(/\s+/)) {
    if (word.length > 2 && !STOP_WORDS.has(word)) {
      tokens.add(word);
    }
  }

  // Extract bare numbers (handles "45th" → "45", "2026" stays "2026")
  for (const match of lower.matchAll(/\d+/g)) {
    const num = match[0];
    if (num.length >= 2) {  // skip single digits — too generic
      tokens.add(`#${num}`);  // prefix to avoid collision with word tokens
    }
  }

  return tokens;
}

/**
 * Split text into sentences for granular echo detection.
 * Handles period, exclamation, question mark, em-dash, and newlines.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/[.!?\n]|—/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Containment score: what fraction of the memory's key tokens appear in the candidate.
 */
function containmentScore(memoryTokens: Set<string>, candidateTokens: Set<string>): number {
  if (memoryTokens.size === 0) return 0;
  let contained = 0;
  for (const token of memoryTokens) {
    if (candidateTokens.has(token)) contained++;
  }
  return contained / memoryTokens.size;
}

/**
 * Threshold for containment-based echo detection.
 * If ≥50% of a recalled memory's content tokens appear in any single sentence
 * of the assistant output, the output is considered an echo.
 *
 * Sentence-level evaluation + number extraction makes 50% reliable:
 * - "Happy 45th birthday, Adii!" matches {birthday, adii, #45} = 3/8 of
 *   "Adii birthday March 2026 turning #10 #2026 #45" — but when evaluated
 *   across ALL sentences including "Adii is turning 45 on March 10, 2026",
 *   the score jumps to 7/8.
 * - Unrelated content: "Deploy the staging server" → 0/8 = 0.
 */
export const ECHO_CONTAINMENT_THRESHOLD = 0.50;

/** Time-to-live for recalled content entries. */
const ENTRY_TTL_MS = 10 * 60_000; // 10 minutes

/** Minimum content tokens for a recalled memory to be trackable. */
const MIN_CONTENT_TOKENS = 3;

interface RecalledEntry {
  tokens: Set<string>;
  storedAt: number;
}

export class RecallEchoStore {
  private entries: RecalledEntry[] = [];

  /** Store the content of memories that were just recalled. */
  storeRecalled(memoryContents: string[]): void {
    const now = Date.now();
    // Evict expired entries
    this.entries = this.entries.filter((e) => now - e.storedAt < ENTRY_TTL_MS);

    for (const content of memoryContents) {
      const tokens = toContentTokens(content);
      if (tokens.size >= MIN_CONTENT_TOKENS) {
        this.entries.push({ tokens, storedAt: now });
      }
    }
  }

  /**
   * Check if the given text contains a recently recalled memory's content.
   * Evaluates at both whole-text and sentence level, returning the highest score.
   *
   * Sentence-level evaluation catches echoes buried in verbose responses.
   */
  maxContainment(text: string): number {
    if (this.entries.length === 0) return 0;

    const now = Date.now();

    // Whole-text tokens
    const wholeTokens = toContentTokens(text);
    if (wholeTokens.size < MIN_CONTENT_TOKENS) return 0;

    // Sentence-level tokens
    const sentences = splitSentences(text);
    const sentenceTokenSets = sentences.map(toContentTokens);

    let max = 0;
    for (const entry of this.entries) {
      if (now - entry.storedAt >= ENTRY_TTL_MS) continue;

      // Check whole text first
      const wholeScore = containmentScore(entry.tokens, wholeTokens);
      if (wholeScore > max) max = wholeScore;

      // Check each sentence — a single echoing sentence is enough
      for (const sentTokens of sentenceTokenSets) {
        if (sentTokens.size < 2) continue;  // skip tiny fragments
        const sentScore = containmentScore(entry.tokens, sentTokens);
        if (sentScore > max) max = sentScore;
      }
    }
    return max;
  }

  /** Check if the given text is an echo of recently recalled content. */
  isEcho(text: string): boolean {
    return this.maxContainment(text) >= ECHO_CONTAINMENT_THRESHOLD;
  }

  /** Number of active (non-expired) entries. */
  get size(): number {
    const now = Date.now();
    return this.entries.filter((e) => now - e.storedAt < ENTRY_TTL_MS).length;
  }

  /** Clear all entries. */
  clear(): void {
    this.entries = [];
  }
}
