import { describe, expect, it } from 'vitest';
import { runDir, safeSegment } from '../src/activities/io';

describe('runDir', () => {
  it('builds paths under run-data/<runId>', () => {
    expect(runDir('r1', 'glossary', 'debates', '沈澈', 'decision.json')).toBe('run-data/r1/glossary/debates/沈澈/decision.json');
  });
  it('neutralizes traversal in model-produced segments', () => {
    expect(runDir('r1', 'debates', '../../etc', 'x.json')).toBe('run-data/r1/debates/.._.._etc/x.json');
    expect(runDir('r1', 'debates', '..', 'x.json')).toBe('run-data/r1/debates/_/x.json');
    expect(safeSegment('a/b\\c\0d')).toBe('a_b_c_d');
  });
});
