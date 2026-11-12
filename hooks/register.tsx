import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Overrides, Phase, Score, UiState } from '../types'
import { pauseSpam, summary } from './messages'

// off -> flash (a short blink) -> on (the game) -> off, driven by the turn.
const phase = atom({ plugin: 'whack-a-mlaude', key: 'phase' } as const, 'off' as Phase)

// Bumped whenever the real-text feed grows, so the game region redraws with it.
const tick = atom({ plugin: 'whack-a-mlaude', key: 'tick' } as const, 0)

// What /whack changes mid-session; kept apart from the /config values.
const overrides = atom({ plugin: 'whack-a-mlaude', key: 'overrides' } as const, {} as Overrides, {
  shape: 'overrides-2',
})
const DEFAULT_UI: UiState = { hidden: false, paused: false, epoch: 0 }
const ui = atom({ plugin: 'whack-a-mlaude', key: 'ui' } as const, DEFAULT_UI, {
  shape: 'ui-1',
})
// The score as of the last finished prompt; the live score is in `live`.
const ZERO: Score = { hits: 0, misses: 0 }
const score = atom({ plugin: 'whack-a-mlaude', key: 'score' } as const, ZERO, {
  shape: 'score-1',
})

// Plain module variables: they only smooth one round and a reload loses
// nothing that matters (the score itself lives in the atom above).
let live: Score = { hits: 0, misses: 0 } // the game posts its score here
let roundStart: Score = { hits: 0, misses: 0 }
let wasShown = false
let pauseStamps: number[] = []

type Entry = { n: number; text: string; color: string }
type Spam = { count: number; windowMs: number }
const WHITE = '#ebebeb'
const GRAY = '#8c8c8c'

const summarize = (e: Record<string, unknown>) => {
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
    const v = e[k]
    if (typeof v === 'string') return (v.split('\n')[0] ?? '').slice(0, 120)
  }
  return ''
}

const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const bool = (v: unknown, fallback: boolean) =>
  typeof v === 'boolean' ? v : fallback
const pickOne = <T,>(list: T[], fallback: T): T =>
  list[Math.floor(Math.random() * list.length)] ?? fallback

// The end-of-round line: tier by whacks, placeholders filled in.
const buildSummary = (hits: number, misses: number, total: number) => {
  const tiers = [...summary].sort((a, b) => a.minHits - b.minHits)
  let tier = tiers[0]
  for (const t of tiers) if (hits >= t.minHits) tier = t
  const accuracy = hits + misses > 0 ? Math.round((100 * hits) / (hits + misses)) : 0
  const line = pickOne(tier?.lines ?? [], 'Round over.')
    .replace(/\{hits\}/g, String(hits))
    .replace(/\{misses\}/g, String(misses))
    .replace(/\{total\}/g, String(total))
    .replace(/\{accuracy\}/g, String(accuracy))
  return `[${hits} whacked | ${misses} missed | total ${total}] ${line}`
}

// /whack <word> <number>
const NUMS: Record<string, { key: keyof Overrides; min: number; max: number }> = {
  speed: { key: 'speed', min: 0.25, max: 4 },
  moles: { key: 'maxMoles', min: 1, max: 12 },
  height: { key: 'height', min: 4, max: 40 },
  lifetime: { key: 'lifetimeMs', min: 500, max: 10000 },
  spawnmin: { key: 'spawnMinMs', min: 100, max: 10000 },
  spawnmax: { key: 'spawnMaxMs', min: 100, max: 10000 },
  scroll: { key: 'scrollMs', min: 300, max: 10000 },
}
// /whack <word> [on|off]
const FLAGS: Record<string, keyof Overrides> = {
  marker: 'marker',
  hover: 'hover',
  ramp: 'ramp',
  score: 'showScore',
  summary: 'summary',
  compact: 'compactSummary',
}

const HELP = [
  '/whack            hide or show the game (also /ww)',
  '/whack pause | resume | restart | status | reset',
  '/whack speed|moles|height|lifetime|spawnmin|spawnmax|scroll <number>',
  '/whack marker|hover|ramp|score|summary|compact [on|off]',
  'In the game area (click it once to focus): p pause, h hide, r restart.',
  'More settings (spawn area, score handling, pause-spam and more) are in /config.',
].join('\n')

type MergedCfg = Record<string, number | boolean>

// Pausing too often too quickly earns a cheeky comment. A top-level function
// so the engine can follow `$` into it.
async function setPaused($: any, want: boolean | 'toggle', spam: Spam): Promise<string> {
  const cur: UiState = (await read($, ui)) ?? DEFAULT_UI
  const paused = want === 'toggle' ? !cur.paused : want
  await update($, ui, (u: UiState | undefined) => ({ ...(u ?? DEFAULT_UI), paused }))
  let text = paused ? 'paused' : 'resumed'

  if (paused && !cur.paused) {
    const now: number = await $.clock.now()
    pauseStamps = pauseStamps.filter(t => now - t < spam.windowMs)
    pauseStamps.push(now)
    if (pauseStamps.length >= spam.count) {
      pauseStamps = []
      const line = pickOne(pauseSpam, 'Easy on the pause button.')
      $.ui.toast(line, { timeoutMs: 6000 })
      text += ` - ${line}`
    }
  }
  return text
}

async function restartGame($: any): Promise<void> {
  live = { hits: 0, misses: 0 }
  roundStart = { hits: 0, misses: 0 }
  await update($, score, () => ({ hits: 0, misses: 0 }))
  await update($, ui, (u: UiState | undefined) => {
    const cur = u ?? DEFAULT_UI
    return { ...cur, epoch: cur.epoch + 1 }
  })
}

// A top-level function so the engine can follow `$` into it.
async function runCommand(
  $: any,
  args: string,
  merged: (o: Overrides) => MergedCfg,
  spam: Spam,
): Promise<string> {
  const [word = '', value] = args.trim().toLowerCase().split(/\s+/)

  if (word === '') {
    await update($, ui, (u: UiState | undefined) => {
      const cur = u ?? DEFAULT_UI
      return { ...cur, hidden: !cur.hidden }
    })
    return 'whack: toggled hide/show'
  }
  if (word === 'help') return HELP
  if (word === 'hide' || word === 'show') {
    await update($, ui, (u: UiState | undefined) => ({
      ...(u ?? DEFAULT_UI),
      hidden: word === 'hide',
    }))
    return `whack: ${word === 'hide' ? 'hidden' : 'shown'}`
  }
  if (word === 'pause' || word === 'resume') {
    return `whack: ${await setPaused($, word === 'pause', spam)}`
  }
  if (word === 'restart') {
    await restartGame($)
    return 'whack: restarted, score reset'
  }
  if (word === 'reset') {
    await update($, overrides, () => ({}))
    return 'whack: back to the /config values'
  }
  if (word === 'status') {
    const o = (await read($, overrides)) ?? {}
    const u = (await read($, ui)) ?? DEFAULT_UI
    const m = merged(o)
    return [
      `whack: ${u.hidden ? 'hidden' : 'shown'}, ${u.paused ? 'paused' : 'running'}, score ${live.hits} (${live.misses} missed)`,
      `speed ${m.speed}, moles ${m.maxMoles}, height ${m.height}, lifetime ${m.lifetimeMs}ms`,
      `spawn ${m.spawnMinMs}-${m.spawnMaxMs}ms, scroll ${m.scrollMs}ms`,
      `marker ${m.marker}, hover ${m.hover}, ramp ${m.ramp}, score ${m.showScore}, summary ${m.summary}, compact ${m.compactSummary}`,
    ].join('\n')
  }

  const numSpec = NUMS[word]
  if (numSpec) {
    const n = Number(value)
    if (!Number.isFinite(n)) return `whack: ${word} needs a number (${numSpec.min}-${numSpec.max})`
    const clamped = Math.min(numSpec.max, Math.max(numSpec.min, n))
    await update($, overrides, (o: Overrides | undefined) => ({ ...(o ?? {}), [numSpec.key]: clamped }))
    return `whack: ${word} = ${clamped}`
  }

  const flagKey = FLAGS[word]
  if (flagKey) {
    const o = (await read($, overrides)) ?? {}
    const current = Boolean(merged(o)[flagKey])
    const next =
      value === 'on' || value === 'true' || value === '1'
        ? true
        : value === 'off' || value === 'false' || value === '0'
          ? false
          : !current
    await update($, overrides, (x: Overrides | undefined) => ({ ...(x ?? {}), [flagKey]: next }))
    return `whack: ${word} ${next ? 'on' : 'off'}`
  }

  return `whack: unknown option "${word}"\n${HELP}`
}

export const register: Register = (on, options) => {
  const isEnabled = bool(options.enabled, true)
  const flashMs = num(options.flashMs, 0)
  const isKeepScore = bool(options.keepScore, true)
  const isRemembered = bool(options.rememberScore, false)
  const spam: Spam = {
    count: Math.round(num(options.pauseSpamCount, 10)),
    windowMs: num(options.pauseSpamWindowSec, 20) * 1000,
  }

  // The session's real text, newest last. A module variable: it only feeds
  // the game, so a reload that empties it costs nothing but the history.
  const feed: Entry[] = []
  let seq = 0
  const push = (text: string, color: string, first = '', isDeduped = false) => {
    const lines = text.replace(/\r/g, '').replace(/\t/g, '  ').split('\n').slice(0, 14)
    lines.forEach((raw, i) => {
      const clean = raw.replace(/[^\x20-\x7e]/g, '·').slice(0, 200)
      const line = (i === 0 ? first : ' '.repeat(first.length)) + clean
      if (isDeduped && feed.slice(-60).some(f => f.text === line)) return
      feed.push({ n: ++seq, text: line, color })
    })
    if (feed.length > 120) feed.splice(0, feed.length - 120)
  }

  // The /config values; /whack overrides are merged over them when drawing.
  const base = {
    height: Math.round(num(options.height, 10)),
    speed: num(options.speed, 1),
    maxMoles: Math.round(num(options.maxMoles, 3)),
    spawnMinMs: num(options.spawnMinMs, 500),
    spawnMaxMs: num(options.spawnMaxMs, 1300),
    lifetimeMs: num(options.lifetimeMs, 2200),
    spawnMinRow: Math.round(num(options.spawnMinRow, 0)),
    spawnMaxRow: Math.round(num(options.spawnMaxRow, -1)),
    ramp: bool(options.ramp, true),
    hover: bool(options.hover, true),
    marker: bool(options.marker, false),
    showScore: bool(options.showScore, true),
    scrollMs: num(options.scrollMs, 2200),
    summary: bool(options.summary, true),
    compactSummary: bool(options.compactSummary, false),
  }
  const merged = (o: Overrides) => {
    const m = { ...base, ...o }
    m.spawnMaxMs = Math.max(m.spawnMinMs, m.spawnMaxMs)
    return m
  }

  on('session.start', async ($, e, next) => {
    await update($, phase, () => 'off' as Phase)
    if (isRemembered) {
      const saved = (await $.store.get('score')) as Partial<Score> | undefined
      if (saved && typeof saved.hits === 'number' && typeof saved.misses === 'number') {
        const restored: Score = { hits: saved.hits, misses: saved.misses }
        await update($, score, () => restored)
      }
    }
    for (const name of ['whack', 'ww']) {
      await $.command.register({
        name,
        description: 'Whack-a-mole: hide, pause or change settings mid-game',
        argumentHint: '[hide|show|pause|resume|restart|status|reset|help|<setting> <value>]',
        immediate: true,
      })
    }
    return next(e)
  })

  on('command.run', { command: 'whack' }, async ($, e) => ({
    text: await runCommand($, e.args, merged, spam),
  }))
  on('command.run', { command: 'ww' }, async ($, e) => ({
    text: await runCommand($, e.args, merged, spam),
  }))

  // What the game area tells us: its score, and keys pressed in it.
  on('ui.message', async ($, e, next) => {
    const msg = e.data as { cmd?: string; hits?: unknown; misses?: unknown } | null
    if (msg?.cmd === 'score') {
      if (typeof msg.hits === 'number' && typeof msg.misses === 'number') {
        live = { hits: msg.hits, misses: msg.misses }
      }
    } else if (msg?.cmd === 'pause') {
      await setPaused($, 'toggle', spam)
    } else if (msg?.cmd === 'hide') {
      await update($, ui, (u: UiState | undefined) => {
        const cur = u ?? DEFAULT_UI
        return { ...cur, hidden: !cur.hidden }
      })
    } else if (msg?.cmd === 'restart') {
      await restartGame($)
    }
    return next(e)
  })

  // --------------------------------------------------------- real text --
  on('prompt.submit', async ($, e, next) => {
    push(e.text, WHITE, '> ')
    await update($, tick, n => (n ?? 0) + 1)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const call = e as unknown as Record<string, unknown>
    push(`● ${String(call.tool)}(${summarize(call)})`, WHITE)
    await update($, tick, n => (n ?? 0) + 1)

    const ran = await next(e)

    const out = (ran as { text?: unknown }).text
    if (typeof out === 'string' && out.trim()) {
      push(out.trim(), GRAY, '  ⎿  ')
      await update($, tick, n => (n ?? 0) + 1)
    }
    return ran
  })

  // The assistant's own words, picked up as the transcript draws them.
  on('ui.render', { component: 'AssistantMessage' }, (_$, e, next) => {
    push(e.props.text, WHITE, e.props.isFirstOfReply ? '● ' : '  ', true)
    return next(e)
  })

  // ------------------------------------------------------------- turn --
  // The main loop starts working: blink, then show the game.
  on('turn.start', async ($, e, next) => {
    if (e.agentId || !isEnabled) return next(e)

    // The score carries over from the last prompt, unless told not to.
    if (!isKeepScore) await update($, score, () => ({ hits: 0, misses: 0 }))
    roundStart = { ...((await read($, score)) ?? ZERO) }
    live = { ...roundStart }
    wasShown = true

    if (flashMs > 0) {
      await update($, phase, () => 'flash' as Phase)
      await $.clock.sleep(flashMs)
      // An abort during the flash already set 'off'; don't undo it.
      await update($, phase, p => (p === 'flash' ? 'on' : p) as Phase)
    } else {
      await update($, phase, () => 'on' as Phase)
    }

    return next(e)
  })

  // Done (answered, interrupted or failed): bank the score, say well done,
  // and the game goes away.
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      await update($, phase, () => 'off' as Phase)
      if (wasShown) {
        wasShown = false
        const total: Score = { ...live }
        await update($, score, () => total)
        if (isRemembered) await $.store.set('score', total)

        const hits = total.hits - roundStart.hits
        const misses = total.misses - roundStart.misses
        const sm = merged((await read($, overrides)) ?? {})
        if (sm.summary && hits + misses > 0) {
          if (sm.compactSummary) {
            // small and quiet: just the numbers, gone after a few seconds
            $.ui.toast(`${hits} whacked | ${misses} missed`, { timeoutMs: 3000 })
          } else {
            $.ui.toast(buildSummary(hits, misses, total.hits), { timeoutMs: 9000 })
          }
        }
      }
    }
    return next(e)
  })

  on('turn.abort', async ($, e, next) => {
    await update($, phase, () => 'off' as Phase)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, phase)
    await read($, tick) // subscribe: new real text redraws the game's props
    const o = (await read($, overrides)) ?? {}
    const u = (await read($, ui)) ?? DEFAULT_UI
    const banked = (await read($, score)) ?? ZERO
    // The game region (Client) exists on the terminal surface only.
    if (current === 'off' || u.hidden || !isEnabled || e.surface !== 'terminal') {
      return next(e)
    }

    const cfg = merged(o)
    const { Box, Text, Client } = $.ui.resolve(e)

    if (current === 'flash') {
      const fill = '▒'.repeat(Math.max(1, e.props.bodyColumns - 1))
      return (
        <Box flexDirection="column">
          {Array.from({ length: cfg.height }, (_, i) => (
            <Text key={`f${i}`} color="#cd7828" inverse>
              {fill}
            </Text>
          ))}
        </Box>
      )
    }

    return (
      <Client
        key={`game${u.epoch}`}
        module="./game.tsx"
        props={{
          ...cfg,
          paused: u.paused,
          startHits: banked.hits,
          startMisses: banked.misses,
          feed: feed.slice(-80),
        }}
        width="100%"
        height={cfg.height}
      />
    )
  })
}
