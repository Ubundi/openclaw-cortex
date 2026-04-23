import { describe, expect, it } from "vitest";

import {
  collectValueSignals,
  parseAuditIndex,
  redactSecrets,
  renderHtmlReport,
} from "../../scripts/lib/cortex-audit-report.mjs";

describe("cortex audit report helpers", () => {
  it("parses newline-delimited audit index entries", () => {
    const entries = parseAuditIndex([
      "{\"ts\":\"2026-03-28T16:13:38.195Z\",\"feature\":\"auto-capture\",\"endpoint\":\"/v1/jobs/ingest/conversation\",\"payloadFile\":\"a.txt\",\"sessionId\":\"s1\",\"userId\":\"u1\",\"msgs\":7}",
      "{\"ts\":\"2026-03-28T16:14:13.069Z\",\"feature\":\"auto-recall\",\"endpoint\":\"/v1/retrieve\",\"payloadFile\":\"b.txt\",\"userId\":\"u1\"}",
    ].join("\n"));

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      feature: "auto-capture",
      endpoint: "/v1/jobs/ingest/conversation",
      payloadFile: "a.txt",
      sessionId: "s1",
      userId: "u1",
      messageCount: 7,
    });
  });

  it("redacts api keys and bearer tokens while preserving surrounding context", () => {
    const input = [
      "user: sk_noryFFzAouUv21GbhjPBpq9Jx7UGSEzE",
      "Authorization: Bearer abcdef1234567890",
      "normal line",
    ].join("\n");

    const redacted = redactSecrets(input);

    expect(redacted).toContain("[REDACTED_API_KEY]");
    expect(redacted).toContain("Authorization: Bearer [REDACTED_TOKEN]");
    expect(redacted).toContain("normal line");
    expect(redacted).not.toContain("sk_noryFFzAouUv21GbhjPBpq9Jx7UGSEzE");
  });

  it("extracts durable user preferences and workflow rules from auto-capture payloads", () => {
    const entries = [
      {
        ts: "2026-03-28T16:29:42.036Z",
        feature: "auto-capture",
        endpoint: "/v1/jobs/ingest/conversation",
        payloadFile: "capture.txt",
        sessionId: "7a057109-4377-45dc-8022-e7858039e1c9",
        userId: "u1",
        messageCount: 3,
      },
    ];

    const payloads = new Map([
      ["capture.txt", `user: No why don't you just tell me the last four expenses in the KD & GM group?

By the way this is the group that I'm going to be using most regularly. It's me and my girlfriend in it so it might be worth you storing the ID of that group to use as a default.

Also let's just reiterate: when I ask you to add an expense, update an expense, or manage an expense, I want you to make sure that you have all of the necessary information from me before you go ahead and do that. You are permitted to ask me for those.
It should have:
- an expense description
- a date for that expense
- a currency
- a split type
- an amount
- who paid

Is that right?

assistant: I’m going to do two things: save your Splitsmarter preferences/default-group note, then query the API to find the KD & GM group and pull its latest expenses.`],
    ]);

    const signals = collectValueSignals(entries, payloads);
    const summaries = signals.map((signal) => signal.summary);

    expect(summaries).toContain("KD & GM is the user's default Splitsmarter group.");
    expect(summaries).toContain("Expense management requests must include description, date, currency, split type, amount, and who paid.");
  });

  it("renders a future recall example section in the html report", () => {
    const html = renderHtmlReport({
      instanceLabel: "i-demo",
      userId: "u1",
      sessionId: "s1",
      metrics: {
        "auto-capture": 1,
        "auto-recall": 2,
        "auto-recall-fallback": 0,
        "tool-search-memory": 0,
      },
      signals: [
        {
          kind: "default",
          summary: "KD & GM is the user's default Splitsmarter group.",
          whyItMatters: "The agent can reuse that default later.",
          source: "KD & GM group",
          ts: "2026-03-28T16:29:42.036Z",
          feature: "auto-capture",
        },
        {
          kind: "workflow-rule",
          summary: "Expense management requests must include description, date, currency, split type, amount, and who paid.",
          whyItMatters: "The agent can gather the right fields later.",
          source: "description, date, currency, split type, amount, who paid",
          ts: "2026-03-28T16:29:42.036Z",
          feature: "auto-capture",
        },
      ],
      evidence: [],
      timeline: [],
      timeRange: "range",
    });

    expect(html).toContain("Future Recall Example");
    expect(html).toContain("If the user returns later");
    expect(html).toContain("KD &amp; GM");
    expect(html).toContain("description, date, currency, split type, amount, and who paid");
  });
});
