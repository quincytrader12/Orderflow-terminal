import { describe, expect, it } from 'vitest';
import { hovered, newFollow, pause, resumeIn, RESUME_MS, shouldResume } from './follow';

describe('live follow', () => {
  it('follows until panned, then resumes after the owner leaves it alone', () => {
    const f = newFollow();
    expect(shouldResume(f, 0)).toBe(false);
    pause(f, 1000);
    expect(f.live).toBe(false);
    expect(resumeIn(f, 1000)).toBe(10);
    expect(shouldResume(f, 1000 + RESUME_MS - 1)).toBe(false);
    expect(shouldResume(f, 1000 + RESUME_MS)).toBe(true);
  });

  it('waits while the pointer is still moving over the chart', () => {
    const f = newFollow();
    pause(f, 0);
    hovered(f, RESUME_MS - 500);
    expect(shouldResume(f, RESUME_MS + 100)).toBe(false);
    expect(shouldResume(f, RESUME_MS + 2600)).toBe(true);
  });
});
