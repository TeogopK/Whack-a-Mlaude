// Text the game says to the player. Plain arrays of strings: no code needed.
// One line per entry, ASCII only (the terminal grid is fixed-width).

/**
 * Said when pause is pressed too many times too quickly (pausing to farm
 * points). Cheeky, never mean.
 */
export const pauseSpam: string[] = [
  'Pause-farming, are we?',
  'Easy there, speedrunner. Moles do not respect time-outs.',
  'The pause key called. It wants a day off.',
  'Cheating a mole game. Your manager would be so proud.',
  'Pause, unpause, pause... the moles are getting dizzy.',
]

/**
 * End-of-round summaries, picked by how many moles you whacked this round
 * (the tier with the highest minHits that you reached). Placeholders:
 *   {hits} whacked this round    {misses} missed this round
 *   {total} your running total   {accuracy} hit rate this round, in %
 */
export const summary: { minHits: number; lines: string[] }[] = [
  {
    minHits: 0,
    lines: ['Not a single whack. Were you actually working?'],
  },
  {
    minHits: 1,
    lines: ['Keep whacking.'],
  },
  {
    minHits: 10,
    lines: ['You call this working?'],
  },
  {
    minHits: 60,
    lines: ['Probably not worth the tokens.'],
  },
  {
    minHits: 100,
    lines: ['Vibecoding god.'],
  },
]
