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

export class CortexClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async retrieve(
    query: string,
    topK: number,
    mode: "fast" | "full",
    timeoutMs: number,
  ): Promise<RetrieveResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/v1/retrieve`, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, top_k: topK, mode }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Cortex retrieve failed: ${res.status}`);
      }

      return (await res.json()) as RetrieveResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  async ingest(text: string, sessionId?: string): Promise<IngestResponse> {
    const res = await fetch(`${this.baseUrl}/v1/ingest`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, session_id: sessionId }),
    });

    if (!res.ok) {
      throw new Error(`Cortex ingest failed: ${res.status}`);
    }

    return (await res.json()) as IngestResponse;
  }

  async ingestConversation(
    messages: ConversationMessage[],
    sessionId?: string,
  ): Promise<IngestResponse> {
    const res = await fetch(`${this.baseUrl}/v1/ingest/conversation`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages, session_id: sessionId }),
    });

    if (!res.ok) {
      throw new Error(`Cortex ingest/conversation failed: ${res.status}`);
    }

    return (await res.json()) as IngestResponse;
  }

  async reflect(sessionId?: string): Promise<ReflectResponse> {
    const res = await fetch(`${this.baseUrl}/v1/reflect`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session_id: sessionId }),
    });

    if (!res.ok) {
      throw new Error(`Cortex reflect failed: ${res.status}`);
    }

    return (await res.json()) as ReflectResponse;
  }
}
