export interface RetrieveResult {
  node_id: string;
  type: string;
  content: string;
  score: number;
  source?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface RetrieveResponse {
  results: RetrieveResult[];
}

export interface IngestFact {
  core: string;
  fact_type: string;
  occurred_at: string | null;
  entity_refs: string[];
  speaker: string;
}

export interface IngestEntity {
  name: string;
  type: string;
  aliases: string[];
}

export interface IngestResponse {
  nodes_created: number;
  edges_created: number;
  facts: IngestFact[];
  entities: IngestEntity[];
}

export interface ReflectResponse {
  synthesized_count: number;
  superseded_count: number;
}

export interface ConversationMessage {
  role: string;
  content: string;
}

const DEFAULT_INGEST_TIMEOUT_MS = 10_000;
const DEFAULT_REFLECT_TIMEOUT_MS = 30_000;

export class CortexClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private async fetchJsonWithTimeout<T>(
    url: string,
    body: unknown,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Cortex ${label} failed: ${res.status}`);
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async retrieve(
    query: string,
    topK: number,
    mode: "fast" | "full",
    timeoutMs: number,
  ): Promise<RetrieveResponse> {
    return this.fetchJsonWithTimeout<RetrieveResponse>(
      `${this.baseUrl}/v1/retrieve`,
      { query, top_k: topK, mode },
      timeoutMs,
      "retrieve",
    );
  }

  async ingest(
    text: string,
    sessionId?: string,
    timeoutMs = DEFAULT_INGEST_TIMEOUT_MS,
  ): Promise<IngestResponse> {
    return this.fetchJsonWithTimeout<IngestResponse>(
      `${this.baseUrl}/v1/ingest`,
      { text, session_id: sessionId },
      timeoutMs,
      "ingest",
    );
  }

  async ingestConversation(
    messages: ConversationMessage[],
    sessionId?: string,
    timeoutMs = DEFAULT_INGEST_TIMEOUT_MS,
  ): Promise<IngestResponse> {
    return this.fetchJsonWithTimeout<IngestResponse>(
      `${this.baseUrl}/v1/ingest/conversation`,
      { messages, session_id: sessionId },
      timeoutMs,
      "ingest/conversation",
    );
  }

  async reflect(
    sessionId?: string,
    timeoutMs = DEFAULT_REFLECT_TIMEOUT_MS,
  ): Promise<ReflectResponse> {
    return this.fetchJsonWithTimeout<ReflectResponse>(
      `${this.baseUrl}/v1/reflect`,
      { session_id: sessionId },
      timeoutMs,
      "reflect",
    );
  }
}
