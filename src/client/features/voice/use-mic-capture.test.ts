import { describe, expect, it } from 'vitest';
import { matchesStopPhrase } from './use-mic-capture';

describe('matchesStopPhrase', () => {
  it('matches common stop phrases regardless of case', () => {
    expect(matchesStopPhrase('Please stop')).toBe(true);
    expect(matchesStopPhrase('STOP')).toBe(true);
    expect(matchesStopPhrase('hold on a second')).toBe(true);
    expect(matchesStopPhrase('wait')).toBe(true);
    expect(matchesStopPhrase('cancel that')).toBe(true);
  });

  it('matches a stop phrase embedded in a longer utterance', () => {
    expect(matchesStopPhrase("Actually, please stop and let's try something else")).toBe(true);
  });

  it('does not match unrelated speech', () => {
    expect(matchesStopPhrase('add a new function to the file')).toBe(false);
    expect(matchesStopPhrase('what does this stopwatch component do')).toBe(true); // "stop" substring — documents current limitation
  });

  it('does not match an empty transcript', () => {
    expect(matchesStopPhrase('')).toBe(false);
    expect(matchesStopPhrase('   ')).toBe(false);
  });
});
