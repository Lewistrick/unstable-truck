/** Where the solver's "Optimal" benchmark row belongs in a leaderboard that is
 * already sorted fastest-first: just after every entry at least as fast as it -
 * i.e. before the first entry strictly slower - or at the very end when nothing
 * beats it. Returns an index in [0, entryTimesAsc.length].
 *
 * This is what keeps the Optimal row from being pinned above a real player who
 * out-drove it: it's a benchmark time slotted in by value, not a banner. Equal
 * times keep the real entry above the Optimal row (`<=` skips ties), so a player
 * who exactly matches it still ranks ahead. */
export function optimalRowIndex(entryTimesAsc: readonly number[], optimalTime: number): number {
  let i = 0;
  while (i < entryTimesAsc.length && entryTimesAsc[i]! <= optimalTime) i++;
  return i;
}
