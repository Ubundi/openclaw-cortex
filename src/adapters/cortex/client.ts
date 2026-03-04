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
  emotions?: string[];
  values?: string[];
  beliefs?: string[];
  insights?: string[];
  life_context?: string[];
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

export type QueryType = "factual" | "emotional" | "combined" | "codex";

export interface BatchIngestItem {
  text: string;
  session_id?: string;
  reference_date?: string;
  user_id?: string;
  source_origin?: string;
  derivation_mode?: string;
  source_app?: string;
}

export interface BatchIngestResponse {
  results: IngestResponse[];
  total_nodes_created: number;
  total_edges_created: number;
  failed_count: number;
  errors: string[];
}

export interface GeneratePairingCodeResponse {
  user_code: string;
  expires_in: number;
  expires_at: string;
}

export interface HealthCheckResponse {
  status: string;
}

export interface JobSubmitResponse {
  job_id: string;
  status: string;
}

// --- Agent API Types ---

export interface RecallMemory {
  content: string;
  confidence: number;
  when: string | null;
  session_id: string | null;
  entities: string[];
  type?: NodeType;
  grounded?: boolean;
  source_origin?: string;
  derivation_mode?: string;
  source_app?: string;
}

export interface RecallResponse {
  memories: RecallMemory[];
}

export interface RememberAcceptedResponse {
  session_id: string | null;
  status?: string;
}

export interface RememberResponse {
  session_id: string | null;
  memories_created: number;
  entities_found: string[];
  facts: string[];
  emotions: string[];
  values: string[];
  beliefs: string[];
  insights: string[];
}

export interface ForgetResponse {
  memories_removed: number;
}

export interface KnowledgeEntity {
  name: string;
  memory_count: number;
  last_seen: string;
}

export interface KnowledgeResponse {
  total_memories: number;
  total_sessions: number;
  maturity: "cold" | "warming" | "mature";
  entities: KnowledgeEntity[];
}

export interface StatsResponse {
  pipeline_tier: 1 | 2 | 3;
  pipeline_maturity: "cold" | "warming" | "mature";
  [key: string]: unknown;
}

// --- Internal API Defaults ---
const DEFAULT_INGEST_TIMEOUT_MS = 45_000;
const DEFAULT_SUBMIT_TIMEOUT_MS = 10_000;
const DEFAULT_REFLECT_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_WARMUP_TIMEOUT_MS = 60_000;

// --- Agent API Defaults ---
const DEFAULT_REMEMBER_TIMEOUT_MS = 45_000;
const DEFAULT_RECALL_TIMEOUT_MS = 10_000;
const DEFAULT_SOURCE_ORIGIN = "openclaw";
const DEFAULT_DERIVATION_MODE = "inferred";
const DEFAULT_SOURCE_APP = "OpenClaw";

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
    return this.fetchRequest<T>(url, { method: "POST", body: JSON.stringify(body) }, timeoutMs, label);
  }

  private async fetchRequest<T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          "x-api-key": this.apiKey,
          "Content-Type": "application/json",
          ...init.headers,
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        let detail = "";
        try {
          const body = await res.text();
          if (body) detail = ` — ${body.slice(0, 300)}`;
        } catch {}
        throw new Error(`Cortex ${label} failed: ${res.status}${detail}`);
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireIngestUserId(userId?: string): string {
    if (typeof userId !== "string" || userId.trim().length === 0) {
      throw new Error("Cortex ingest requires user_id");
    }
    return userId;
  }

  private buildIngestProvenance(
    userId?: string,
    sourceOrigin = DEFAULT_SOURCE_ORIGIN,
    derivationMode = DEFAULT_DERIVATION_MODE,
    sourceApp = DEFAULT_SOURCE_APP,
  ): {
    user_id: string;
    source_origin: string;
    derivation_mode: string;
    source_app: string;
  } {
    return {
      user_id: this.requireIngestUserId(userId),
      source_origin: sourceOrigin,
      derivation_mode: derivationMode,
      source_app: sourceApp,
    };
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
    options?: { referenceDate?: string; debug?: boolean; userId?: string; sessionId?: string; forceTier?: 1 | 2 | 3 },
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
        ...(options?.userId ? { user_id: options.userId } : {}),
        ...(options?.sessionId ? { session_id: options.sessionId } : {}),
        ...(options?.forceTier ? { force_tier: options.forceTier } : {}),
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
    userId?: string,
    sourceOrigin = DEFAULT_SOURCE_ORIGIN,
    sourceApp = DEFAULT_SOURCE_APP,
    derivationMode = DEFAULT_DERIVATION_MODE,
  ): Promise<IngestResponse> {
    return this.fetchJsonWithTimeout<IngestResponse>(
      `${this.baseUrl}/v1/ingest`,
      {
        text,
        session_id: sessionId,
        reference_date: referenceDate ?? null,
        ...this.buildIngestProvenance(userId, sourceOrigin, derivationMode, sourceApp),
      },
      timeoutMs,
      "ingest",
    );
  }

  async ingestConversation(
    messages: ConversationMessage[],
    sessionId?: string,
    timeoutMs = DEFAULT_INGEST_TIMEOUT_MS,
    referenceDate?: string,
    userId?: string,
    sourceOrigin = DEFAULT_SOURCE_ORIGIN,
    sourceApp = DEFAULT_SOURCE_APP,
    derivationMode = DEFAULT_DERIVATION_MODE,
  ): Promise<IngestResponse> {
    return this.fetchJsonWithTimeout<IngestResponse>(
      `${this.baseUrl}/v1/ingest/conversation`,
      {
        messages,
        session_id: sessionId,
        reference_date: referenceDate ?? null,
        ...this.buildIngestProvenance(userId, sourceOrigin, derivationMode, sourceApp),
      },
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
    userId?: string,
    sourceOrigin = DEFAULT_SOURCE_ORIGIN,
    sourceApp = DEFAULT_SOURCE_APP,
    derivationMode = DEFAULT_DERIVATION_MODE,
  ): Promise<JobSubmitResponse> {
    return this.fetchJsonWithTimeout<JobSubmitResponse>(
      `${this.baseUrl}/v1/jobs/ingest`,
      {
        text,
        session_id: sessionId,
        reference_date: referenceDate ?? null,
        ...this.buildIngestProvenance(userId, sourceOrigin, derivationMode, sourceApp),
      },
      DEFAULT_SUBMIT_TIMEOUT_MS,
      "jobs/ingest",
    );
  }

  async submitIngestConversation(
    messages: ConversationMessage[],
    sessionId?: string,
    referenceDate?: string,
    userId?: string,
    sourceOrigin = DEFAULT_SOURCE_ORIGIN,
    sourceApp = DEFAULT_SOURCE_APP,
    derivationMode = DEFAULT_DERIVATION_MODE,
  ): Promise<JobSubmitResponse> {
    return this.fetchJsonWithTimeout<JobSubmitResponse>(
      `${this.baseUrl}/v1/jobs/ingest/conversation`,
      {
        messages,
        session_id: sessionId,
        reference_date: referenceDate ?? null,
        ...this.buildIngestProvenance(userId, sourceOrigin, derivationMode, sourceApp),
      },
      DEFAULT_SUBMIT_TIMEOUT_MS,
      "jobs/ingest/conversation",
    );
  }

  async batchIngest(
    items: BatchIngestItem[],
    timeoutMs = DEFAULT_INGEST_TIMEOUT_MS,
    userId?: string,
    sourceOrigin = DEFAULT_SOURCE_ORIGIN,
    sourceApp = DEFAULT_SOURCE_APP,
    derivationMode = DEFAULT_DERIVATION_MODE,
  ): Promise<BatchIngestResponse> {
    const fallbackUserId = userId ? this.requireIngestUserId(userId) : undefined;
    const enrichedItems = items.map((item, index) => {
      const effectiveUserId = item.user_id ?? fallbackUserId;
      if (!effectiveUserId || effectiveUserId.trim().length === 0) {
        throw new Error(`Cortex ingest/batch item ${index} missing user_id`);
      }

      return {
        ...item,
        user_id: effectiveUserId,
        source_origin: item.source_origin ?? sourceOrigin,
        derivation_mode: item.derivation_mode ?? derivationMode,
        source_app: item.source_app ?? sourceApp,
      };
    });
    return this.fetchJsonWithTimeout<BatchIngestResponse>(
      `${this.baseUrl}/v1/ingest/batch`,
      { items: enrichedItems },
      timeoutMs,
      "ingest/batch",
    );
  }

  async reflect(
    timeoutMs = DEFAULT_REFLECT_TIMEOUT_MS,
  ): Promise<ReflectResponse> {
    return this.fetchJsonWithTimeout<ReflectResponse>(
      `${this.baseUrl}/v1/reflect`,
      {},
      timeoutMs,
      "reflect",
    );
  }

  // --- Agent API Methods ---

  async remember(
    text: string,
    sessionId?: string,
    timeoutMs = DEFAULT_REMEMBER_TIMEOUT_MS,
    referenceDate?: string,
    userId?: string,
    sourceOrigin = DEFAULT_SOURCE_ORIGIN,
    sourceApp = DEFAULT_SOURCE_APP,
    derivationMode = DEFAULT_DERIVATION_MODE,
  ): Promise<RememberAcceptedResponse> {
    return this.fetchJsonWithTimeout<RememberAcceptedResponse>(
      `${this.baseUrl}/v1/remember`,
      {
        text,
        session_id: sessionId ?? null,
        reference_date: referenceDate ?? null,
        ...this.buildIngestProvenance(userId, sourceOrigin, derivationMode, sourceApp),
      },
      timeoutMs,
      "remember",
    );
  }

  async rememberConversation(
    messages: ConversationMessage[],
    sessionId?: string,
    timeoutMs = DEFAULT_REMEMBER_TIMEOUT_MS,
    referenceDate?: string,
    userId?: string,
    sourceOrigin = DEFAULT_SOURCE_ORIGIN,
    sourceApp = DEFAULT_SOURCE_APP,
    derivationMode = DEFAULT_DERIVATION_MODE,
  ): Promise<RememberAcceptedResponse> {
    return this.fetchJsonWithTimeout<RememberAcceptedResponse>(
      `${this.baseUrl}/v1/remember`,
      {
        messages,
        session_id: sessionId ?? null,
        reference_date: referenceDate ?? null,
        ...this.buildIngestProvenance(userId, sourceOrigin, derivationMode, sourceApp),
      },
      timeoutMs,
      "remember",
    );
  }

  async recall(
    query: string,
    timeoutMs = DEFAULT_RECALL_TIMEOUT_MS,
    options?: {
      limit?: number;
      context?: string;
      sessionFilter?: string;
      userId?: string;
      queryType?: QueryType;
      minConfidence?: number;
      includeUngrounded?: boolean;
      includeOrigins?: string[];
      excludeOrigins?: string[];
      derivationMode?: string;
    },
  ): Promise<RecallResponse> {
    return this.fetchJsonWithTimeout<RecallResponse>(
      `${this.baseUrl}/v1/recall`,
      {
        query,
        limit: options?.limit ?? undefined,
        context: options?.context ?? undefined,
        session_filter: options?.sessionFilter ?? undefined,
        user_id: options?.userId ?? undefined,
        query_type: options?.queryType ?? undefined,
        min_confidence: options?.minConfidence ?? undefined,
        include_ungrounded: options?.includeUngrounded ?? undefined,
        ...(options?.includeOrigins ? { include_origins: options.includeOrigins } : {}),
        ...(options?.excludeOrigins ? { exclude_origins: options.excludeOrigins } : {}),
        ...(options?.derivationMode ? { derivation_mode: options.derivationMode } : {}),
      },
      timeoutMs,
      "recall",
    );
  }

  async forgetSession(
    sessionId: string,
    timeoutMs = DEFAULT_RECALL_TIMEOUT_MS,
  ): Promise<ForgetResponse> {
    return this.fetchRequest<ForgetResponse>(
      `${this.baseUrl}/v1/forget/session/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
      timeoutMs,
      "forget/session",
    );
  }

  async forgetEntity(
    entityName: string,
    timeoutMs = DEFAULT_RECALL_TIMEOUT_MS,
  ): Promise<ForgetResponse> {
    return this.fetchRequest<ForgetResponse>(
      `${this.baseUrl}/v1/forget/entity/${encodeURIComponent(entityName)}`,
      { method: "DELETE" },
      timeoutMs,
      "forget/entity",
    );
  }

  async knowledge(
    timeoutMs = DEFAULT_RECALL_TIMEOUT_MS,
    userId?: string,
  ): Promise<KnowledgeResponse> {
    const url = userId
      ? `${this.baseUrl}/v1/knowledge?user_id=${encodeURIComponent(userId)}`
      : `${this.baseUrl}/v1/knowledge`;
    return this.fetchRequest<KnowledgeResponse>(
      url,
      { method: "GET" },
      timeoutMs,
      "knowledge",
    );
  }

  async generatePairingCode(
    agentUserId: string,
    timeoutMs = DEFAULT_RECALL_TIMEOUT_MS,
  ): Promise<GeneratePairingCodeResponse> {
    return this.fetchJsonWithTimeout<GeneratePairingCodeResponse>(
      `${this.baseUrl}/v1/auth/code`,
      { agent_user_id: agentUserId },
      timeoutMs,
      "auth/code",
    );
  }

  async stats(
    timeoutMs = DEFAULT_RECALL_TIMEOUT_MS,
    userId?: string,
  ): Promise<StatsResponse> {
    const url = userId
      ? `${this.baseUrl}/v1/stats?user_id=${encodeURIComponent(userId)}`
      : `${this.baseUrl}/v1/stats`;
    return this.fetchRequest<StatsResponse>(
      url,
      { method: "GET" },
      timeoutMs,
      "stats",
    );
  }
}
