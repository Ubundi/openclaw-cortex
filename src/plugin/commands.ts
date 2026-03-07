import type { CortexClient } from "../cortex/client.js";
import type { CortexConfig } from "./config.js";
import type { CommandDefinition, Logger } from "./types.js";
import type { AuditLogger } from "../internal/audit-logger.js";
import { AuditLogger as AuditLoggerImpl } from "../internal/audit-logger.js";
import { createCheckpointHandler } from "../features/checkpoint/handler.js";
import type { SessionStateStore } from "../internal/session-state.js";

export interface CommandsDeps {
  client: CortexClient;
  config: CortexConfig;
  logger: Logger;
  getUserId: () => string | undefined;
  userIdReady: Promise<void>;
  getLastMessages: () => unknown[];
  sessionId: string;
  auditLoggerProxy: AuditLogger;
  sessionState: SessionStateStore;
  getWorkspaceDir: () => string | undefined;
  getAuditLoggerInner: () => AuditLogger | undefined;
  setAuditLoggerInner: (logger: AuditLogger | undefined) => void;
}

export function buildCommands(
  registerCommand: (definition: CommandDefinition) => void,
  deps: CommandsDeps,
): void {
  const {
    client,
    config,
    logger,
    getUserId,
    userIdReady,
    getLastMessages,
    sessionId,
    auditLoggerProxy,
    sessionState,
    getWorkspaceDir,
    getAuditLoggerInner,
    setAuditLoggerInner,
  } = deps;

  const checkpointHandler = createCheckpointHandler(
    client,
    config,
    logger,
    getUserId,
    userIdReady,
    getLastMessages,
    sessionId,
    auditLoggerProxy,
  );

  registerCommand({
    name: "audit",
    description: "Toggle or check Cortex audit log (records all data sent to Cortex)",
    acceptsArgs: true,
    handler: (ctx) => {
      const arg = ctx.args?.trim().toLowerCase();
      const workspaceDirResolved = getWorkspaceDir();

      if (arg === "on") {
        if (!workspaceDirResolved) {
          return { text: "Cannot enable audit log — no workspace directory available. The plugin must be started with a workspace first." };
        }
        if (getAuditLoggerInner()) {
          return { text: `Audit log is already enabled.\nAll Cortex API calls are being recorded at:\n\`${workspaceDirResolved}/.cortex/audit/\`` };
        }
        setAuditLoggerInner(new AuditLoggerImpl(workspaceDirResolved, logger));
        logger.info(`Cortex audit log enabled via command: ${workspaceDirResolved}/.cortex/audit/`);
        return {
          text: [
            `**Audit log enabled.**`,
            ``,
            `All data sent to and received from Cortex will be recorded locally.`,
            `Log path: \`${workspaceDirResolved}/.cortex/audit/\``,
            ``,
            `Turn off with \`/audit off\`. Log files are preserved when disabled.`,
          ].join("\n"),
        };
      }

      if (arg === "off") {
        if (!getAuditLoggerInner()) {
          return { text: "Audit log is already off. No data is being recorded." };
        }
        setAuditLoggerInner(undefined);
        logger.info("Cortex audit log disabled via command");
        return {
          text: [
            `**Audit log disabled.**`,
            ``,
            `Cortex API calls are no longer being recorded.`,
            `Existing log files are preserved and can be reviewed at:`,
            `\`${workspaceDirResolved}/.cortex/audit/\``,
          ].join("\n"),
        };
      }

      // No args — show status
      const status = getAuditLoggerInner() ? "on" : "off";
      const lines = [
        `**Cortex Audit Log**`,
        ``,
        `The audit log records all data sent to and received from the Cortex API, stored locally for inspection.`,
        ``,
        `- Status: **${status}**`,
        `- Config default: ${config.auditLog ? "on" : "off"}`,
      ];
      if (workspaceDirResolved) {
        lines.push(`- Log path: \`${workspaceDirResolved}/.cortex/audit/\``);
      }
      lines.push("", "Toggle: `/audit on` · `/audit off`");
      return { text: lines.join("\n") };
    },
  });

  registerCommand({
    name: "checkpoint",
    description: "Save a session checkpoint to Cortex before resetting",
    acceptsArgs: true,
    handler: checkpointHandler,
  });

  registerCommand({
    name: "sleep",
    description: "Mark the current session as cleanly ended (clears recovery warning state)",
    acceptsArgs: false,
    handler: async () => {
      try {
        await sessionState.clear();
        return {
          text: [
            `**Session ended cleanly.**`,
            ``,
            `Cortex will not show a recovery warning when you start your next session.`,
            `Use \`/checkpoint\` before \`/sleep\` if you want to save a summary of what you were working on.`,
          ].join("\n"),
        };
      } catch (err) {
        return { text: `Failed to mark session clean: ${String(err)}` };
      }
    },
  });
}
