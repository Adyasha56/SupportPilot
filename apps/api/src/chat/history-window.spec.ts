import { describe, expect, it } from 'vitest';
import { HistoryTurn } from '../agent/loop/run-agent';
import { capHistoryByChars } from './history-window';

function turn(text: string): HistoryTurn {
  return { role: 'customer', text };
}

describe('capHistoryByChars', () => {
  it('returns the full history unchanged when under the char budget', () => {
    const history = [turn('hi'), turn('there')];
    expect(capHistoryByChars(history, 100)).toEqual(history);
  });

  it('drops the oldest turns first until under budget', () => {
    const history = [turn('aaaaa'), turn('bbbbb'), turn('ccccc')]; // 5 chars each, 15 total
    expect(capHistoryByChars(history, 10)).toEqual([turn('bbbbb'), turn('ccccc')]);
  });

  it('keeps at least the single most recent turn even if it alone exceeds the budget', () => {
    const history = [turn('aaaaa'), turn('a very long final turn that alone exceeds the budget')];
    const result = capHistoryByChars(history, 10);
    expect(result).toEqual([history[1]]);
  });

  it('an empty history stays empty', () => {
    expect(capHistoryByChars([], 100)).toEqual([]);
  });

  it('exactly at the budget is not trimmed', () => {
    const history = [turn('12345'), turn('67890')]; // exactly 10
    expect(capHistoryByChars(history, 10)).toEqual(history);
  });
});
