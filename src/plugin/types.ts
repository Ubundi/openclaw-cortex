// --- OpenClaw Plugin API types (per docs.openclaw.ai/tools/plugin) ---

export interface HookMetadata {
  name: string;
  description: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}

export interface CommandDefinition {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: CommandContext) => Promise<{ text: string }> | { text: string };
}

export interface CommandContext {
  senderId?: string;
  channel?: string;
  isAuthorizedSender?: boolean;
  args?: string;
  commandBody?: string;
  config?: Record<string, unknown>;
}

export interface PluginApi {
  pluginConfig?: Record<string, unknown>;
  config?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  logger: Logger;
  // Legacy hook registration (kept for backward compatibility)
  on?(hookName: string, handler: (...args: any[]) => any, opts?: { priority?: number }): void;
  // Modern hook registration with metadata
  registerHook?(
    hookName: string,
    handler: (...args: any[]) => any,
    metadata: HookMetadata,
  ): void;
  registerService(service: {
    id: string;
    start?: (ctx: { workspaceDir?: string }) => void;
    stop?: (ctx: { workspaceDir?: string }) => void;
  }): void;
  // Agent tools (LLM-invocable functions)
  registerTool?(definition: ToolDefinition, options?: { optional?: boolean }): void;
  // Auto-reply commands (execute without AI agent)
  registerCommand?(definition: CommandDefinition): void;
  // Gateway RPC methods
  registerGatewayMethod?(
    name: string,
    handler: (ctx: { respond: (ok: boolean, data: unknown) => void }) => void,
  ): void;
  // CLI commands (terminal-level, uses Commander.js)
  registerCli?(
    registrar: (ctx: { program: CliProgram; config: Record<string, unknown>; workspaceDir?: string; logger: Logger }) => void,
    opts?: { commands?: string[] },
  ): void;
}

export interface CliProgram {
  command(name: string): CliCommand;
}

export interface CliCommand {
  description(desc: string): CliCommand;
  command(name: string): CliCommand;
  argument(name: string, desc: string): CliCommand;
  option(flags: string, desc: string, defaultValue?: string): CliCommand;
  action(fn: (...args: any[]) => void | Promise<void>): CliCommand;
}

export interface Logger {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
