import type { ClientSurface, ClientPointerEvent } from 'claude-code'

// The game itself: runs inside a Client region above the prompt. It looks like
// scrolling agent output; characters slowly morph into a mole (•ω•) that you
// whack by hovering / clicking.

type Entry = { n: number; text: string; color: string }
type Cfg = {
  startHits: number // the score carried over from earlier prompts
  startMisses: number
  paused: boolean
  feed: Entry[] // the session's real text, newest last
  height: number
  speed: number
  maxMoles: number
  spawnMinMs: number
  spawnMaxMs: number
  lifetimeMs: number
  spawnMinRow: number
  spawnMaxRow: number
  ramp: boolean
  hover: boolean
  marker: boolean
  showScore: boolean
  compactSummary: boolean // quiet score row: dim grey, not bold
  scrollMs: number
}
type Line = { text: string; color: string }
type Mole = { r: number; c: number; born: number }
type Flash = { r: number; s: number; until: number }
type Game = {
  cfg: Cfg
  n: number // text rows (region height minus the score row)
  w: number
  now: number
  rows: Line[]
  queue: Line[]
  moles: Mole[]
  flashes: Flash[]
  hits: number
  misses: number
  px: number
  py: number
  sparkUntil: number
  sparkX: number
  sparkY: number
  postedHits: number // what the hooks side was last told
  postedMisses: number
  nextSpawn: number
  nextScroll: number
  seed: number
  seen: number // highest feed entry already shown
}
type Local = { g: Game; v: number }
type Cell = { ch: string; color: string; bold?: boolean; inverse?: boolean }

const FRAME_MS = 60

const GRAY = '#8c8c8c'
const MOLE = '#cd7828'
const HIT = '#78ff8c'
const DIRT = '#6e4623'

const SPRITE = ['(', '•', 'ω', '•', ')']
const SPRITE_COLOR = ['#be7846', '#f5f5f5', '#ff96aa', '#f5f5f5', '#be7846']
const REVEAL = [2, 1, 3, 0, 4]
const SQUISHED = ['(', '>', 'ω', '<', ')']

// ---------------------------------------------------------------- helpers --
const rnd = (g: Game) => {
  // mulberry32: no Math.random dependency, stable across frames
  g.seed = (g.seed + 0x6d2b79f5) | 0
  let t = Math.imul(g.seed ^ (g.seed >>> 15), 1 | g.seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = <T,>(g: Game, list: T[]) =>
  list[Math.floor(rnd(g) * list.length)] as T

const toRgb = (hex: string): number[] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]
const blend = (a: string, b: string, t: number) => {
  const x = toRgb(a)
  const y = toRgb(b)
  const hx = (i: number) =>
    Math.round((x[i] ?? 0) + ((y[i] ?? 0) - (x[i] ?? 0)) * t)
      .toString(16)
      .padStart(2, '0')
  return `#${hx(0)}${hx(1)}${hx(2)}`
}

// One real feed entry as screen lines, wrapped to the region's width.
const wrapEntry = (g: Game, e: Entry): Line[] => {
  const width = Math.max(20, g.w - 4)
  const out: Line[] = []
  let t = e.text
  while (t.length > width) {
    let cut = t.lastIndexOf(' ', width)
    if (cut < width * 0.5) cut = width
    out.push({ text: (out.length ? '    ' : '') + t.slice(0, cut), color: e.color })
    t = t.slice(cut).trimStart()
  }
  out.push({ text: (out.length ? '    ' : '') + t, color: e.color })
  return out
}

// Only ever real session text: fresh lines first, older real ones replayed when
// none are waiting, and blank rows until the session has produced any.
const nextLine = (g: Game): Line => {
  if (g.queue.length === 0) {
    const feed = g.cfg.feed
    if (feed.length > 0) {
      const fresh = feed.find(e => e.n > g.seen)
      if (fresh) g.seen = fresh.n
      g.queue = wrapEntry(g, fresh ?? pick(g, feed))
    } else {
      g.queue = [{ text: '', color: GRAY }]
    }
  }
  return g.queue.shift() as Line
}

// ------------------------------------------------------------------- rules --
const effSpeed = (g: Game) =>
  Math.max(0.1, g.cfg.speed * (g.cfg.ramp ? 1 + Math.min(g.hits * 0.02, 1.5) : 1))
const lifetime = (g: Game) => Math.max(500, g.cfg.lifetimeMs / effSpeed(g))
const spawnStart = (g: Game, c: number) =>
  Math.max(0, Math.min(c - 2, g.w - 1 - SPRITE.length))

const progress = (g: Game, m: Mole) => {
  const f = (g.now - m.born) / lifetime(g)
  if (f < 0.55) return f / 0.55
  if (f < 0.75) return 1
  return Math.max(0, 1 - (f - 0.75) / 0.25)
}

const spawn = (g: Game) => {
  const lo = Math.max(0, Math.min(g.n - 1, g.cfg.spawnMinRow))
  const hiRaw = g.cfg.spawnMaxRow < 0 ? g.n - 1 : g.cfg.spawnMaxRow
  const hi = Math.max(lo, Math.min(g.n - 1, hiRaw))
  for (let i = 0; i < 25; i++) {
    const r = lo + Math.floor(rnd(g) * (hi - lo + 1))
    const text = (g.rows[r] as Line).text
    if (!text) continue
    const c = Math.floor(rnd(g) * Math.min(text.length, g.w - 1))
    const ch = text[c] ?? ' '
    if (ch > ' ' && ch <= '~' && !g.moles.some(m => m.r === r && m.c === c)) {
      g.moles.push({ r, c, born: g.now })
      return
    }
  }
}

const whack = (g: Game, x: number, y: number) => {
  for (const m of g.moles) {
    if (m.r !== y) continue
    const s = spawnStart(g, m.c)
    const onSprite = progress(g, m) >= 0.3 && x >= s && x < s + SPRITE.length
    if (x === m.c || onSprite) {
      g.moles = g.moles.filter(o => o !== m)
      g.hits += 1
      g.flashes.push({ r: m.r, s, until: g.now + 350 })
      g.sparkUntil = g.now + 250
      g.sparkX = x
      g.sparkY = y
      return
    }
  }
}

const tick = (g: Game) => {
  g.now += FRAME_MS
  if (g.now >= g.nextSpawn) {
    if (g.moles.length < g.cfg.maxMoles) spawn(g)
    const gap = g.cfg.spawnMinMs + rnd(g) * (g.cfg.spawnMaxMs - g.cfg.spawnMinMs)
    g.nextSpawn = g.now + gap / effSpeed(g)
  }
  if (g.now >= g.nextScroll) {
    g.rows.shift()
    g.rows.push(nextLine(g))
    const up = <T extends { r: number }>(l: T[]) =>
      l.filter(o => o.r > 0).map(o => ({ ...o, r: o.r - 1 }))
    g.moles = up(g.moles)
    g.flashes = up(g.flashes)
    // Catch up quickly while real lines are waiting to be shown.
    const backlog = g.cfg.feed.some(e => e.n > g.seen + 3)
    g.nextScroll = g.now + (backlog ? 350 : g.cfg.scrollMs * (0.7 + 0.6 * rnd(g)))
  }
  const life = lifetime(g)
  const alive = g.moles.filter(m => g.now - m.born < life)
  g.misses += g.moles.length - alive.length
  g.moles = alive
  g.flashes = g.flashes.filter(f => f.until > g.now)
}

const resize = (g: Game, rows: number, cols: number) => {
  const n = Math.max(1, rows - 1)
  if (n === g.n && cols === g.w) return
  g.n = n
  g.w = cols
  g.rows = []
  while (g.rows.length < n) g.rows.push(nextLine(g))
  g.moles = []
  g.flashes = []
}

// ----------------------------------------------------------------- drawing --
const overlay = (g: Game): Map<string, Cell> => {
  const ov = new Map<string, Cell>()
  const put = (r: number, c: number, cell: Cell) => {
    if (r >= 0 && r < g.n && c >= 0 && c < g.w - 1) ov.set(`${r},${c}`, cell)
  }
  for (const m of g.moles) {
    const p = progress(g, m)
    if (p <= 0.05) continue
    const line = g.rows[m.r] as Line
    if (m.c < line.text.length) {
      put(m.r, m.c, { ch: line.text[m.c] ?? ' ', color: blend(line.color, MOLE, p), bold: p > 0.5 })
    }
    if (p < 0.3) continue
    const count = 1 + Math.min(SPRITE.length - 1, Math.floor(((p - 0.3) / 0.7) * SPRITE.length))
    const s = spawnStart(g, m.c)
    for (const k of REVEAL.slice(0, count)) {
      put(m.r, s + k, {
        ch: SPRITE[k] as string,
        color: SPRITE_COLOR[k] as string,
        bold: true,
      })
    }
    if (count === SPRITE.length) {
      for (let k = 0; k < SPRITE.length; k++) put(m.r + 1, s + k, { ch: '▀', color: DIRT })
    }
  }
  for (const f of g.flashes) {
    SQUISHED.forEach((ch, k) => put(f.r, f.s + k, { ch, color: HIT, bold: true }))
  }
  if (g.cfg.marker) {
    // One small mark: the character under the pointer glows softly (unless a
    // mole already draws there), and a spark pops where a mole was hit.
    if (g.px >= 0 && !ov.has(`${g.py},${g.px}`)) {
      const under = g.rows[g.py]?.text[g.px] ?? ' '
      put(g.py, g.px, { ch: under, color: MOLE, bold: true })
    }
    if (g.now < g.sparkUntil) {
      put(g.sparkY, g.sparkX, { ch: '✦', color: HIT, bold: true })
    }
  }
  return ov
}

const rowRuns = (g: Game, r: number, ov: Map<string, Cell>, els: any) => {
  const { Text } = els
  const line = g.rows[r] as Line
  const text = line.text.padEnd(g.w - 1).slice(0, g.w - 1)
  const runs: any[] = []
  let cur: Cell | null = null
  let buf = ''
  const flush = () => {
    if (cur && buf) {
      runs.push(
        <Text key={runs.length} color={cur.color} bold={cur.bold}>
          {buf}
        </Text>,
      )
    }
    buf = ''
  }
  for (let c = 0; c < text.length; c++) {
    const cell: Cell = ov.get(`${r},${c}`) ?? { ch: text[c] ?? ' ', color: line.color }
    if (!cur || cell.color !== cur.color || !!cell.bold !== !!cur.bold) {
      flush()
      cur = cell
    }
    buf += cell.ch
  }
  flush()
  return runs
}

export default function Whack(props: Cfg, surface: ClientSurface<Local>) {
  const { Box, Text } = surface.elements
  const rows = surface.rows || props.height
  const cols = surface.columns || 80

  if (!surface.state) {
    const g: Game = {
      cfg: props,
      n: 0,
      w: 0,
      now: 0,
      rows: [],
      queue: [],
      moles: [],
      flashes: [],
      hits: props.startHits,
      misses: props.startMisses,
      postedHits: props.startHits,
      postedMisses: props.startMisses,
      px: -1,
      py: -1,
      sparkUntil: 0,
      sparkX: 0,
      sparkY: 0,
      nextSpawn: 1000,
      nextScroll: 1500,
      seed: 0x5eed,
      // start from the most recent real lines, not the whole history
      seen: Math.max(0, (props.feed[props.feed.length - 12]?.n ?? 1) - 1),
    }
    const local: Local = { g, v: 0 }
    const bump = () => {
      local.v += 1
      surface.setState({ g, v: local.v })
    }
    resize(g, rows, cols)
    surface.every(FRAME_MS, () => {
      if (g.cfg.paused) return // frozen: moles, scrolling and the clock stop
      tick(g)
      // Tell the hooks side the score (one post per frame at most) so it
      // survives the game going away between prompts.
      if (g.hits !== g.postedHits || g.misses !== g.postedMisses) {
        g.postedHits = g.hits
        g.postedMisses = g.misses
        surface.post({ cmd: 'score', hits: g.hits, misses: g.misses })
      }
      bump()
    })
    // Keys reach the game once a click has focused it (Esc gives focus back).
    surface.onKey(e => {
      if (e.key === 'p') surface.post({ cmd: 'pause' })
      else if (e.key === 'h') surface.post({ cmd: 'hide' })
      else if (e.key === 'r') surface.post({ cmd: 'restart' })
    })
    surface.onPointer((e: ClientPointerEvent) => {
      if (g.cfg.paused) return
      if (e.type === 'leave') {
        g.px = g.py = -1
      } else {
        g.px = e.x
        g.py = e.y
        if (e.type === 'down') {
          whack(g, e.x, e.y)
        } else if (e.type === 'move' && !e.button && g.cfg.hover) {
          whack(g, e.x, e.y)
        }
      }
      bump()
    })
    surface.setState(local)
    return <Box />
  }

  const g = surface.state.g
  g.cfg = props
  // After a hot reload the feed's numbering restarts below what was shown;
  // without this no line would ever count as new again.
  const newest = props.feed[props.feed.length - 1]
  if (newest && newest.n < g.seen) g.seen = Math.max(0, newest.n - 12)
  resize(g, rows, cols)
  const ov = overlay(g)
  const tag = props.paused
    ? `paused (p resumes)  score ${g.hits} `
    : `score ${g.hits}  missed ${g.misses} `

  return (
    <Box flexDirection="column">
      {Array.from({ length: g.n }, (_, r) => (
        <Text key={`r${r}`}>{rowRuns(g, r, ov, surface.elements)}</Text>
      ))}
      <Text>
        {props.showScore || props.paused ? (
          <Text>
            <Text color={GRAY}>{' '.repeat(Math.max(0, g.w - 1 - tag.length))}</Text>
            <Text color={props.compactSummary ? GRAY : MOLE} bold={!props.compactSummary}>
              {tag}
            </Text>
          </Text>
        ) : (
          ' '
        )}
      </Text>
    </Box>
  )
}
