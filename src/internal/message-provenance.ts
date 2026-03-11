type MessageWithRoleAndProvenance = {
  role?: unknown;
  provenance?: unknown;
};

type ProvenanceRecord = {
  kind?: unknown;
};

function getProvenanceKind(message: MessageWithRoleAndProvenance): string | undefined {
  if (typeof message.provenance !== "object" || message.provenance === null) {
    return undefined;
  }
  const provenance = message.provenance as ProvenanceRecord;
  return typeof provenance.kind === "string" ? provenance.kind : undefined;
}

/**
 * Only literal external-user input should drive memory. When provenance is
 * missing, keep the message for backward compatibility with older runtimes.
 */
export function shouldUseUserMessageForMemory(message: MessageWithRoleAndProvenance): boolean {
  if (message.role !== "user") return false;
  const kind = getProvenanceKind(message);
  return kind === undefined || kind === "external_user";
}

/**
 * Synthetic bridge/routing prompts can appear as user messages; when that
 * happens, the assistant response that follows should also be excluded from any
 * memory-oriented view of the conversation.
 */
export function filterConversationMessagesForMemory<T extends MessageWithRoleAndProvenance>(
  messages: readonly T[],
): T[] {
  const filtered: T[] = [];
  let lastUserWasEligible: boolean | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastUserWasEligible = shouldUseUserMessageForMemory(message);
      if (lastUserWasEligible) filtered.push(message);
      continue;
    }

    if (message.role === "assistant") {
      if (lastUserWasEligible === false) continue;
      filtered.push(message);
    }
  }

  return filtered;
}
