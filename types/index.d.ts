export type Phase = 'off' | 'flash' | 'on'

/** Session-only changes made with /whack; they win over the /config values. */
export type Overrides = {
  speed?: number
  maxMoles?: number
  height?: number
  lifetimeMs?: number
  spawnMinMs?: number
  spawnMaxMs?: number
  scrollMs?: number
  marker?: boolean
  hover?: boolean
  ramp?: boolean
  showScore?: boolean
  summary?: boolean
  compactSummary?: boolean
}

export type UiState = { hidden: boolean; paused: boolean; epoch: number }

export type Score = { hits: number; misses: number }
