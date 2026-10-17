/** One agent of a tool's box; `now` is its latest action (a command, an edit, a reply). */
export type AgentRow = { depth: number; text: string; now?: string | null }

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
}

/** One of this session's running Claude subagents and its latest tool call. */
export type SubAgent = { id: string; label: string; type: string; isNested: boolean; now?: string }

/** The small model's read of the session after the last turn: the task, its steps, what to do next. */
export type Brief = { task: string; steps: string[]; next: string; why?: string; isWaiting: boolean }

declare module 'claude-code' {
  interface PluginState {
    'agent-boxes': {
      scan: Scan | null
      claude: ClaudeBox | null
      subagents: SubAgent[]
      brief: Brief | null
      tasks: Task[]
    }
  }
}
