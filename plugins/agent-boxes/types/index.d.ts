/** One agent of a tool's box; `now` is its latest action (a command, an edit, a reply). */
export type AgentRow = { depth: number; text: string; now?: string | null }

/** One quota window as a number: % used (null when unknown) and when it resets, if known. */
export type Window = { used: number | null; resetsAtMs?: number }

/** A provider's 5h and 7d windows, for the router; either may be missing. */
export type Windows = { '5h'?: Window | null; '7d'?: Window | null }

/**
 * One tool's box from scripts/boxes.py: whether the tool is installed, its quota windows
 * (one line each), this session's runs, and a hint or error to show.
 */
export type ToolBox = {
  installed?: boolean
  limits: string[]
  agents: AgentRow[]
  fiveHour?: number | null
  sevenDay?: number | null
  windows?: Windows
  /** agy only: each model group's windows ('gemini', 'claude/gpt'), for the router. */
  groups?: Record<string, Windows>
  hint?: string
  error?: string
  /** Set by the plugin, not boxes.py: the last scan was slow or failed and these boxes are older. */
  stale?: string
}

/** One item of this session's task list (<claude dir>/tasks/<session>/). */
export type Task = { id: string; subject: string; activeForm?: string | null; status: 'pending' | 'in_progress' | 'completed' }

export type Scan = { codex: ToolBox; agy: ToolBox; atMs?: number }

export type ClaudeBox = {
  model: string
  context?: number
  fiveHour?: number
  sevenDay?: number
  windows?: Windows
}

/** One of this session's running Claude subagents and its latest tool call. */
export type SubAgent = { id: string; label: string; type: string; isNested: boolean; now?: string }

/** The small model's read of the session after the last turn: the task, its steps, what to do next. */
export type Brief = { task: string; steps: string[]; next: string; why?: string; isWaiting: boolean }

/**
 * The router box: the router's mode and best-placed pool from the session's start, and the last
 * routed prompt's pick. Null when the router is off.
 */
export type Route = {
  mode: string
  lead: string
  category: string
  size: string
  pick: string
  fallback: string
  why: string
  atMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-boxes': {
      scan: Scan | null
      claude: ClaudeBox | null
      subagents: SubAgent[]
      brief: Brief | null
      tasks: Task[]
      route: Route | null
    }
  }
}
