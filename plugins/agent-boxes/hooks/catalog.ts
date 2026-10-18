// Who can take a task, and who is best at what. Sources and dates are in docs/routing-research.md;
// the user's own config (the `router` key of <claude dir>/agent-boxes/config.json) reorders or disables any of it.

/** Whose quota an executor spends: a subscription, or one of agy's model groups. */
export type Pool = 'claude' | 'codex' | 'agy' | 'agy-claude'

export type Executor = {
  id: string
  /** The Agent tool's subagent_type that runs it. */
  agent: string
  /** For Claude executors: the Agent tool's model alias. */
  model?: string
  pool: Pool
  label: string
  /** Rough cost per task, 1 (cheap) to 5 (expensive); small tasks lean on it. */
  cost: number
  isDisabled?: boolean
  note?: string
}

export const EXECUTORS: Executor[] = [
  { id: 'haiku', agent: 'scout', model: 'haiku', pool: 'claude', label: 'Haiku 5.5', cost: 1 },
  { id: 'sonnet', agent: 'worker', model: 'sonnet', pool: 'claude', label: 'Sonnet 5.5', cost: 4 },
  { id: 'opus', agent: 'architect', model: 'opus', pool: 'claude', label: 'Opus 5.5', cost: 4 },
  {
    id: 'fable',
    agent: 'general-purpose',
    model: 'fable',
    pool: 'claude',
    label: 'Fable 5.1',
    cost: 5,
    isDisabled: true,
    note: 'priciest and slowest, no like-for-like win; enable in config',
  },
  { id: 'sol', agent: 'codex-builder', pool: 'codex', label: 'GPT-6.1 Sol', cost: 1 },
  { id: 'astra', agent: 'codex-astra', pool: 'codex', label: 'GPT-6 Astra', cost: 3 },
  {
    id: 'argon',
    agent: 'agy-argon',
    pool: 'agy',
    label: 'Gemini 4 Argon',
    cost: 2,
    note: 'intro price, set to double; weekly-only quota',
  },
  { id: 'flash', agent: 'agy-flash', pool: 'agy', label: 'Gemini 3.8 Flash', cost: 1 },
  { id: 'opus-agy', agent: 'agy-opus', pool: 'agy-claude', label: 'Opus 5.5 via agy', cost: 4 },
]

export type Category = { id: string; title: string; words: RegExp; ranked: string[] }

// Ranked best first. Where a category ranks a Claude model, the router may fall back to
// opus-agy (same model, Google's quota) once Claude is short.
export const CATEGORIES: Category[] = [
  {
    id: 'lookup',
    title: 'lookup / grep / digest',
    words: /\b(where (is|are|does)|find|grep|search for|look ?up|which file|list (all|the)|digest|summari[sz]e (the )?(log|file|transcript)|what does .* (do|say))\b/i,
    ranked: ['haiku', 'flash', 'sol'],
  },
  {
    id: 'blender',
    title: 'Blender bpy / 3D modelling',
    words: /\b(blender|bpy|mesh|modifier|uv ?(map|unwrap)?|retopo|geometry nodes|sculpt|tripo|3d model|low.?poly|rig(ging)?|\.blend)\b/i,
    ranked: ['opus', 'astra', 'sol', 'argon'],
  },
  {
    id: 'shader',
    title: 'shaders (HLSL / ShaderLab / GLSL)',
    words: /\b(shader|hlsl|shaderlab|shader ?graph|glsl|urp|hdrp|vfx graph|compute shader)\b/i,
    ranked: ['opus', 'sonnet', 'sol'],
  },
  {
    id: 'gamedev',
    title: 'game dev (Unity C# / gameplay)',
    words: /\b(unity|c#|csharp|monobehaviou?r|prefab|gameplay|godot|unreal|game ?object|scriptable ?object|physics|player controller)\b/i,
    ranked: ['opus', 'sol', 'astra'],
  },
  {
    id: 'art',
    title: 'art / visual review',
    words: /\b(render|art ?style|concept art|texture|visual|looks? (like|off|wrong)|screenshot|contact sheet|critique the (look|image))\b/i,
    ranked: ['opus', 'argon', 'sonnet'],
  },
  {
    id: 'review',
    title: 'code review',
    words: /\b(review|audit|second opinion|check (my|the) (code|diff|pr)|pull request|\bpr\b)\b/i,
    ranked: ['opus', 'sol', 'argon'],
  },
  {
    id: 'bugfix',
    title: 'hard bug fix',
    words: /\b(bug|crash(es|ing)?|exception|stack ?trace|regression|broken|doesn'?t work|not working|fails?|failing|error)\b/i,
    ranked: ['argon', 'sonnet', 'opus'],
  },
  {
    id: 'frontend',
    title: 'frontend / UI',
    words: /\b(html|css|react|tailwind|frontend|front-end|web ?page|landing page|ui|ux|layout|component|tsx)\b/i,
    ranked: ['opus', 'astra', 'sonnet'],
  },
  {
    id: 'terminal',
    title: 'terminal / scripts / tooling',
    words: /\b(powershell|bash|shell|script|cli|npm|pip|install|ci|pipeline|git (rebase|merge|history)|build (fails|error)|cron)\b/i,
    ranked: ['sonnet', 'opus', 'astra'],
  },
  {
    id: 'design',
    title: 'architecture / hard design',
    words: /\b(architect(ure)?|design|plan|approach|trade-?offs?|should (i|we)|strategy|how should)\b/i,
    ranked: ['opus', 'sonnet', 'argon'],
  },
  {
    id: 'research',
    title: 'research / compare',
    words: /\b(research|compare|benchmark|investigate|what'?s the best|sources|state of the art)\b/i,
    ranked: ['argon', 'opus', 'sonnet'],
  },
  {
    id: 'refactor',
    title: 'long agentic coding / refactor',
    words: /\b(refactor|migrate|port|rewrite|across the (code ?base|repo)|every file|whole (repo|project))\b/i,
    ranked: ['sonnet', 'opus', 'argon', 'sol'],
  },
  {
    id: 'build',
    title: 'routine build',
    words: /\b(implement|add (a|an|the)|build|create|write (a|the)|make (a|the)|rename|bump|wire up)\b/i,
    ranked: ['sol', 'sonnet', 'flash'],
  },
]

export const GENERAL: Category = { id: 'general', title: 'general', words: /$^/, ranked: ['opus', 'sonnet', 'sol'] }
