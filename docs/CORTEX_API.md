# Cortex API Reference

## HTTP REST API

**Base URL:** `https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod`

**Auth:** `x-api-key` header on all requests. Each API key maps to a tenant with an isolated database (`cortex_{tenant_id}`).

### Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/health` | Health check — returns `{"status": "ok"}` |
| POST | `/v1/ingest` | Ingest raw text — extract facts, entities, emotions — store as graph nodes/edges |
| POST | `/v1/ingest/conversation` | Ingest multi-turn messages — same pipeline with speaker attribution |
| POST | `/v1/retrieve` | Hybrid retrieval query — returns scored memory nodes |
| POST | `/v1/reflect` | Cross-session synthesis — merges and consolidates memory nodes |

---

### GET /health

Returns `{"status": "ok"}` when the service is reachable.

---

### POST /v1/ingest

Ingest raw text. The pipeline extracts facts, entities, and emotions, then stores them as graph nodes and edges.

**Request:**

```json
{
  "text": "I joined Acme Corp in Jan 2024",
  "session_id": "s1",
  "reference_date": null
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | yes | Raw text to ingest |
| `session_id` | string | no | Groups ingested content by session |
| `reference_date` | string \| null | no | ISO date for temporal anchoring |

**Response:**

```json
{
  "nodes_created": 3,
  "edges_created": 2,
  "facts": ["Joined Acme Corp in January 2024"],
  "entities": ["Acme Corp"]
}
```

---

### POST /v1/ingest/conversation

Ingest multi-turn conversation messages. Same extraction pipeline as `/v1/ingest` with speaker attribution.

**Request:**

```json
{
  "messages": [
    { "role": "user", "content": "I started at Acme Corp last year" },
    { "role": "assistant", "content": "That's great! What do you do there?" }
  ],
  "session_id": "s1"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `messages` | array | yes | Array of `{role, content}` message objects |
| `session_id` | string | no | Groups ingested content by session |

**Response:** Same shape as `/v1/ingest`.

---

### POST /v1/retrieve

Hybrid retrieval query. Returns scored memory nodes matching the query.

**Request:**

```json
{
  "query": "What company do I work at?",
  "top_k": 5,
  "query_type": "factual",
  "mode": "full",
  "debug": false
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | yes | — | Natural language query |
| `top_k` | number | no | 5 | Max results to return |
| `query_type` | string | no | `"factual"` | `factual` (facts/entities), `emotional` (emotions/insights/values/beliefs), `combined` (all) |
| `mode` | string | no | `"full"` | `full` (complete Phase A–F pipeline) or `fast` (BM25 + semantic + RRF only, ~80–150ms) |
| `debug` | boolean | no | `false` | Include debug/scoring metadata |

**Response:**

```json
{
  "results": [
    {
      "node_id": "uuid",
      "type": "FACT",
      "content": "Joined Acme Corp in January 2024",
      "score": 0.92,
      "confidence": 0.85,
      "metadata": {}
    }
  ]
}
```

---

### POST /v1/reflect

Cross-session synthesis. Merges related facts, creates observation nodes, and supersedes stale information.

**Request:**

```json
{
  "session_id": "s1"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | string | no | Scope reflection to a specific session |

**Response:**

```json
{
  "synthesized_count": 4,
  "superseded_count": 2
}
```

---

## Python SDK

The `Cortex` class exposes 12 public methods.

### Lifecycle

```python
cortex = Cortex(config=None, api_key=None)  # Create instance
await cortex.connect()                       # Connect to DB
await cortex.disconnect()                    # Cleanup
```

### Ingestion

```python
result = await cortex.ingest(text, session_id=None, reference_date=None)
# → IngestionResult

result = await cortex.ingest_conversation(messages, session_id=None)
# → IngestionResult
```

### Retrieval

```python
results = await cortex.retrieve(query, top_k=5, query_type="factual", debug=False, reference_date=None, mode="full")
# → list[RetrievalResult]

facts = await cortex.retrieve_facts(query, top_k=5, query_type="factual")
# → list[Fact]  (convenience wrapper)
```

### Graph Operations

```python
await cortex.reflect()                    # Cross-session synthesis → observation nodes
await cortex.detect_communities()         # Group related nodes into COMMUNITY summaries
await cortex.get_related(node_id)         # Connected nodes via edges
await cortex.find_contradictions()        # All contradiction edges
await cortex.explain_confidence(node_id)  # Confidence breakdown (supporting/contradicting/decay)
```

---

## Data Model

### Node Types (9)

| Type | Description |
|------|-------------|
| `FACT` | Extracted factual statements |
| `ENTITY` | Named entities (people, orgs, places) |
| `EMOTION` | Emotional states and feelings |
| `INSIGHT` | Derived observations |
| `VALUE` | Personal values |
| `BELIEF` | Beliefs and assumptions |
| `LIFECONTEXT` | Life circumstances and context |
| `SESSION` | Session metadata nodes |
| `COMMUNITY` | Auto-detected clusters of related nodes |

### Edge Types (7)

| Type | Description |
|------|-------------|
| `MENTIONS` | Node references an entity |
| `BEFORE` | Temporal ordering |
| `SUPERSEDES` | Newer information replaces older |
| `CONTRADICTS` | Conflicting information |
| `SUPPORTS` | Corroborating information |
| `ELABORATES` | Adds detail to another node |
| `EXTRACTED_FROM` | Provenance link to source session |

---

## Deployment Architecture

```
Client → API Gateway → Lambda (key validation + tenant routing) → ALB → ECS Fargate (FastAPI) → RDS PostgreSQL 16 + pgvector
```

Each API key maps to a tenant. Each tenant gets an isolated database (`cortex_{tenant_id}`).
