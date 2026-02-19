export type NodeType =
  | "FACT"
  | "ENTITY"
  | "EMOTION"
  | "INSIGHT"
  | "VALUE"
  | "BELIEF"
  | "LIFECONTEXT"
  | "SESSION"
  | "COMMUNITY";

export interface RetrieveResultMetadata {
  speaker?: string;
  fact_type?: string;
  entity_refs?: string[];
  occurred_at?: string | null;
  [key: string]: unknown;
}

export interface RetrieveResult {
  node_id: string;
  type: NodeType;
  content: string;
  score: number;
  source?: string;
  confidence?: number;
  metadata?: RetrieveResultMetadata;
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
  nodes_created: number;
  edges_created: number;
  entities_processed: number;
  entities_skipped: number;
}

export interface WarmupResponse {
  tenant_id: string;
  already_warm: boolean;
}

export interface ConversationMessage {
  role: string;
  content: string;
}

export type QueryType = "factual" | "emotional" | "combined";

export interface BatchIngestItem {
  text: string;
  session_id?: string;
  reference_date?: string;
}

export interface BatchIngestResponse {
  results: IngestResponse[];
  total_nodes_created: number;
  total_edges_created: number;
  failed_count: number;
  errors: string[];
}

export interface HealthCheckResponse {
  status: string;
}

export interface JobSubmitResponse {
  job_id: string;
  status: string;
}

const DEFAULT_INGEST_TIMEOUT_MS = 45_000;
const DEFAULT_SUBMIT_TIMEOUT_MS = 10_000;
const DEFAULT_REFLECT_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_WARMUP_TIMEOUT_MS = 60_000;

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

  async healthCheck(timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        method: "GET",
        headers: { "x-api-key": this.apiKey },
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async warmup(timeoutMs = DEFAULT_WARMUP_TIMEOUT_MS): Promise<WarmupResponse> {
    return this.fetchJsonWithTimeout<WarmupResponse>(
      `${this.baseUrl}/v1/warmup`,
      {},
      timeoutMs,
      "warmup",
    );
  }

  async retrieve(
    query: string,
    topK: number,
    mode: "fast" | "full",
    timeoutMs: number,
    queryType?: QueryType,
    options?: { referenceDate?: string; debug?: boolean },
  ): Promise<RetrieveResponse> {
    return this.fetchJsonWithTimeout<RetrieveResponse>(
      `${this.baseUrl}/v1/retrieve`,
      {
        query,
        top_k: topK,
        mode,
        query_type: queryType,
        reference_date: options?.referenceDate ?? undefined,
        debug: options?.debug ?? undefined,
      },
      timeoutMs,
      "retrieve",
    );
  }

  async ingest(
    text: string,
    sessionId?: string,
    timeoutMs = DEFAULT_INGEST_TIMEOUT_MS,
    referenceDate?: string,
  ): Promise<IngestResponse> {
    return this.fetchJsonWithTimeout<IngestResponse>(
      `${this.baseUrl}/v1/ingest`,
      { text, session_id: sessionId, reference_date: referenceDate ?? null },
      timeoutMs,
      "ingest",
    );
  }

  async ingestConversation(
    messages: ConversationMessage[],
    sessionId?: string,
    timeoutMs = DEFAULT_INGEST_TIMEOUT_MS,
    referenceDate?: string,
  ): Promise<IngestResponse> {
    return this.fetchJsonWithTimeout<IngestResponse>(
      `${this.baseUrl}/v1/ingest/conversation`,
      { messages, session_id: sessionId, reference_date: referenceDate ?? null },
      timeoutMs,
      "ingest/conversation",
    );
  }

  async getJob(jobId: string): Promise<JobSubmitResponse & { result?: IngestResponse; error?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_SUBMIT_TIMEOUT_MS);

    try {
      const res = await fetch(`${this.baseUrl}/v1/jobs/${jobId}`, {
        method: "GET",
        headers: { "x-api-key": this.apiKey },
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Cortex job status failed: ${res.status}`);
      }

      return (await res.json()) as JobSubmitResponse & { result?: IngestResponse; error?: string };
    } finally {
      clearTimeout(timeout);
    }
  }

  async submitIngest(
    text: string,
    sessionId?: string,
    referenceDate?: string,
  ): Promise<JobSubmitResponse> {
    return this.fetchJsonWithTimeout<JobSubmitResponse>(
      `${this.baseUrl}/v1/jobs/ingest`,
      { text, session_id: sessionId, reference_date: referenceDate ?? null },
      DEFAULT_SUBMIT_TIMEOUT_MS,
      "jobs/ingest",
    );
  }

  async submitIngestConversation(
    messages: ConversationMessage[],
    sessionId?: string,
    referenceDate?: string,
  ): Promise<JobSubmitResponse> {
    return this.fetchJsonWithTimeout<JobSubmitResponse>(
      `${this.baseUrl}/v1/jobs/ingest/conversation`,
      { messages, session_id: sessionId, reference_date: referenceDate ?? null },
      DEFAULT_SUBMIT_TIMEOUT_MS,
      "jobs/ingest/conversation",
    );
  }

  async batchIngest(
    items: BatchIngestItem[],
    timeoutMs = DEFAULT_INGEST_TIMEOUT_MS,
  ): Promise<BatchIngestResponse> {
    return this.fetchJsonWithTimeout<BatchIngestResponse>(
      `${this.baseUrl}/v1/ingest/batch`,
      { items },
      timeoutMs,
      "ingest/batch",
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
