/**
 * Provider abstraction for AI agent tools.
 *
 * HookProvider ships today (Claude Code). StreamProvider is the seam for a
 * push-based provider whose events originate outside this process (e.g. an
 * external polling bridge translating some other system's activity into
 * AgentEvents) -- this repo defines the interface and gates its lifecycle on
 * office-client presence; it does not implement or register a concrete
 * StreamProvider itself. A polling-only FileProvider type will be added when a
 * real one actually lands, derived from that provider's needs rather than
 * speculation.
 */

import type { TeamProvider } from './teamProvider.js';

// ── Normalized Events (all provider types produce these) ──────

export type AgentEvent =
  | {
      kind: 'toolStart';
      toolId: string;
      toolName: string;
      input?: unknown;
      /** True when the tool was spawned to run in the background (e.g. Claude's
       *  `run_in_background` on Agent/Task). Handlers use this to suppress ghost
       *  sub-agent characters for teammate spawns. */
      runInBackground?: boolean;
    }
  | { kind: 'toolEnd'; toolId: string }
  | {
      kind: 'turnEnd';
      /** True when the turn ended because the agent went idle waiting on the
       *  user (Claude's Notification(idle_prompt)) rather than simply finishing
       *  its response (Stop). Drives the "Waiting for input" vs "Done" label.
       *  Absent/false = the agent finished its turn (Done). */
      awaitingInput?: boolean;
    }
  | {
      kind: 'subagentStart';
      parentToolId: string;
      toolId: string;
      toolName: string;
      input?: unknown;
      runInBackground?: boolean;
    }
  | { kind: 'subagentEnd'; parentToolId: string; toolId: string }
  | {
      kind: 'subagentTurnEnd';
      parentToolId: string;
      /** 'idle' = subagent is idle and ready for more work; 'completed' = subagent
       *  reported its task done. Some providers emit only one; both route to the
       *  same handler but with different downstream cleanup. */
      reason: 'idle' | 'completed';
    }
  | { kind: 'progress'; toolId: string; data: unknown }
  | { kind: 'permissionRequest' }
  | {
      kind: 'sessionStart';
      source?: string;
      /** For external-session adoption: path to the session's transcript file
       *  (if the provider uses one). Undefined for providers without transcripts. */
      transcriptPath?: string;
      /** Working directory the session was started in. Used to match pending
       *  external sessions against known workspace folders. */
      cwd?: string;
    }
  | { kind: 'sessionEnd'; reason?: string };

// ── Hook-based Provider (CLIs with hooks APIs) ────────────────

export interface HookProvider {
  readonly kind: 'hook';
  readonly id: string;
  readonly displayName: string;
  /** Protocol version. Server refuses to dispatch events from a provider whose
   *  version it doesn't understand. Bump on every breaking change to AgentEvent
   *  / TeamProvider / HookProvider. Start at 1. */
  readonly protocolVersion: number;

  /** Normalize a raw hook event payload into an AgentEvent.
   *  Each CLI sends different JSON (Claude: snake_case, Copilot: camelCase, etc.)
   *  The provider translates to the common AgentEvent format.
   *  Return null for events we should ignore. */
  normalizeHookEvent(raw: Record<string, unknown>): {
    sessionId: string;
    event: AgentEvent;
  } | null;

  /** Install hook scripts that POST to our server. */
  installHooks(serverUrl: string, authToken: string): Promise<void>;
  /** Remove installed hook scripts. */
  uninstallHooks(): Promise<void>;
  /** Check if hooks are currently installed. */
  areHooksInstalled(): Promise<boolean>;
  /** First-run consent copy for THIS provider's hook install: the headline titles the ask, the disclosure is its body
   *  (what is written, what data moves, how to undo; paragraphs split on blank lines). Required, not optional — a
   *  provider that installs anything must state its terms, and the gate ships these verbatim so no client copy can
   *  drift. */
  consentDisclosure(): { headline: string; disclosure: string };

  /** Format tool status for display (e.g., "Read" -> "Reading foo.ts") */
  formatToolStatus(toolName: string, input?: unknown): string;
  /** Tools that don't trigger permission timers */
  readonly permissionExemptTools: ReadonlySet<string>;
  /** Tools that spawn sub-agent characters */
  readonly subagentToolNames: ReadonlySet<string>;
  /** Tools that should show the "reading" character animation instead of "typing".
   *  The provider classifies tools as read-like or write-like; the webview renders
   *  the animation. Allows new providers to override without webview edits. */
  readonly readingTools: ReadonlySet<string>;
  /** Terminal name prefix used when launching this CLI. Used by the extension to
   *  match VS Code terminals to agents for heuristic adoption. */
  readonly terminalNamePrefix?: string;

  /** Context window, in tokens, for a model id this CLI reports in its
   *  transcripts. Transcripts state token usage but never the limit it counts
   *  against, so only the provider can say — and getting it wrong is visible:
   *  the office renders usage/window as a context gauge over every character.
   *  Return undefined for an unrecognized model; the runtime then keeps its
   *  previous estimate and widens it if a context ever exceeds it. */
  contextWindowForModel?(model: string | undefined): number | undefined;

  // ── Optional file fallback (heuristic mode) ──

  /** Session directories to scan. Undefined = no file fallback. */
  getSessionDirs?(workspacePath: string): string[];
  /** Root directories containing every session this provider may have started
   *  (across all workspaces). Used by global session discovery / "Watch All
   *  Sessions". Each returned dir contains subdirs whose entries are session
   *  transcript files. Undefined = this provider doesn't support global scan. */
  getAllSessionRoots?(): string[];
  /** Glob pattern for session files (e.g., '*.jsonl'). */
  readonly sessionFilePattern?: string;
  /** Parse one line of a transcript file into an AgentEvent. */
  parseTranscriptLine?(line: string): AgentEvent | null;
  /** Build CLI launch command for +Agent button. */
  buildLaunchCommand?(
    sessionId: string,
    cwd: string,
    opts?: { bypassPermissions?: boolean },
  ): {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };

  // ── Optional team/subagent extension (Agent Teams on Claude; empty for single-agent CLIs) ──

  /** Optional reference to a TeamProvider. When set, the hook handler registers team-aware
   *  branches (subagent routing, teammate discovery, permission forwarding, etc.). */
  readonly team?: TeamProvider;
}

export interface StreamSessionMeta {
  /** Office area / room grouping key. Maps to AgentState.folderName. */
  folderName?: string;
  /** Character label, e.g. "Claude / feat/41024". */
  displayName?: string;
  /** Short marker for a session running off this machine, e.g. a host id. */
  remoteLabel?: string;
}

export interface StreamEventEnvelope {
  sessionId: string;
  event: AgentEvent;
}

/**
 * Minimal integration boundary for a provider whose AgentEvents are pushed
 * from outside this process rather than pulled from a CLI's hooks/transcripts.
 * Kept deliberately small: unlike HookProvider it has no raw-payload
 * normalization step (the provider does that on its own side before ever
 * calling `emit`), no file-fallback surface, and no team extension.
 *
 * Lifecycle is gated by office-client presence, not by process lifetime: the
 * server calls `start` once the first client connects and awaits the returned
 * disposer once the last client disconnects. A provider backed by external
 * polling relies on this gate to pause its polling at zero clients rather than
 * running unobserved.
 */
export interface StreamProvider {
  readonly kind: 'stream';
  readonly id: string;
  readonly displayName: string;
  /** Protocol version. Server refuses to dispatch events from a provider whose
   *  version it doesn't understand. Bump on every breaking change to AgentEvent
   *  / StreamProvider. Start at 1. */
  readonly protocolVersion: number;

  /** Begin producing events, calling `emit` for each addressed envelope. Resolves
   *  with a disposer the server awaits once the last office client disconnects; the
   *  provider must have stopped producing events by the time it resolves. */
  start(emit: (envelope: StreamEventEnvelope) => void): Promise<() => Promise<void>>;

  /** Per-session display metadata. Called once when the server first materializes
   *  an agent for a session. Optional, may return undefined. */
  getSessionMeta?(sessionId: string): StreamSessionMeta | undefined;

  /** Tools that should show the "reading" character animation instead of
   *  "typing" (mirrors HookProvider.readingTools). */
  readonly readingTools: ReadonlySet<string>;
  /** Format tool status for display, by name only. Must never render tool
   *  input or other payload text -- unlike HookProvider.formatToolStatus,
   *  this signature has no `input` parameter to leak. */
  formatToolStatus(toolName: string): string;
}

// TODO(provider type taxonomy): FileProvider (polling-only CLIs) will be added
// alongside the first real such provider.
