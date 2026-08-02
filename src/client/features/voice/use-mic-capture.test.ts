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
  });

  it('does not match words that merely contain a stop phrase as a substring', () => {
    expect(matchesStopPhrase('what does this stopwatch component do')).toBe(false);
    expect(matchesStopPhrase('please await the response')).toBe(false);
  });

  it('does not match an empty transcript', () => {
    expect(matchesStopPhrase('')).toBe(false);
    expect(matchesStopPhrase('   ')).toBe(false);
  });
});
