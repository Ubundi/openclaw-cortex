import { sanitizeConversationText } from "../features/capture/filter.js";

type MessageWithRole = {
  role?: unknown;
  content?: unknown;
};

function sanitizeContentNode(content: unknown): unknown {
  if (typeof content === "string") {
    return sanitizeConversationText(content);
  }

  if (Array.isArray(content)) {
    return content.map((entry) => sanitizeContentNode(entry));
  }

  if (typeof content === "object" && content !== null) {
    const record = content as Record<string, unknown>;
    const next: Record<string, unknown> = { ...record };

    if (typeof record.text === "string") {
      next.text = sanitizeConversationText(record.text);
    }

    if ("content" in record) {
      next.content = sanitizeContentNode(record.content);
    }

    return next;
  }

  return content;
}

export function sanitizeMessageForTranscript<T extends MessageWithRole>(message: T): T {
  if (message.role !== "user" && message.role !== "assistant") {
    return message;
  }

  return {
    ...message,
    content: sanitizeContentNode(message.content),
  };
}
