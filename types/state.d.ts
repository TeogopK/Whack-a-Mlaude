// The $.state contract. Named in plugin.json; nothing imports this file.
// It must be self-contained, so the shapes mirror types/index.d.ts.
export type WhackState = 'whack-a-mlaude' // makes this an augmentation of 'claude-code'
declare module 'claude-code' {
  interface PluginState {
    'whack-a-mlaude': {
      phase: 'off' | 'flash' | 'on'
      tick: number
      overrides: Shaped<{
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
      }>
      ui: Shaped<{ hidden: boolean; paused: boolean; epoch: number }>
      score: Shaped<{ hits: number; misses: number }>
    }
  }
}
