import { HistoryTurn } from '../agent/loop/run-agent';

/**
 * Stage 4 amendment F - the history window is capped by BOTH message count
 * (applied upstream, as the `limit` on MessageRepository.findRecentForConversation)
 * AND total characters here - whichever limit is hit first wins. Drops
 * from the OLDEST end first (history is already oldest-first), so the most
 * recent turns are always what survives a trim.
 */
export function capHistoryByChars(history: HistoryTurn[], maxChars: number): HistoryTurn[] {
  let totalChars = history.reduce((sum, turn) => sum + turn.text.length, 0);
  let startIndex = 0;

  // Never drops the last remaining turn, even if it alone exceeds maxChars -
  // an empty history would give the agent nothing of the conversation at
  // all, which is worse than one turn over budget.
  while (totalChars > maxChars && startIndex < history.length - 1) {
    totalChars -= history[startIndex].text.length;
    startIndex += 1;
  }

  return startIndex === 0 ? history : history.slice(startIndex);
}
