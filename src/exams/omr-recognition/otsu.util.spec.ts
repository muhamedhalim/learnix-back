import { otsuThreshold } from './otsu.util';

describe('otsuThreshold', () => {
  it('splits a clearly bimodal distribution between the two clusters', () => {
    const low = [0.02, 0.03, 0.01, 0.04, 0.02, 0.0, 0.03];
    const high = [0.85, 0.9, 0.88, 0.92, 0.87];
    const threshold = otsuThreshold([...low, ...high]);
    expect(threshold).toBeGreaterThan(Math.max(...low));
    expect(threshold).toBeLessThan(Math.min(...high));
  });

  it('handles an all-identical distribution without throwing', () => {
    expect(() => otsuThreshold([0.5, 0.5, 0.5, 0.5])).not.toThrow();
  });

  it('handles a single value', () => {
    expect(otsuThreshold([0.42])).toBe(0.42);
  });

  it('handles an empty array with a sane default', () => {
    expect(otsuThreshold([])).toBe(0.5);
  });

  it('is not sensitive to input order', () => {
    const values = [0.9, 0.1, 0.85, 0.05, 0.95, 0.0];
    const a = otsuThreshold(values);
    const b = otsuThreshold([...values].reverse());
    expect(a).toBeCloseTo(b, 9);
  });

  it('finds the correct split with a skewed cluster-size ratio (few marked, many blank)', () => {
    const blank = Array.from({ length: 40 }, () => Math.random() * 0.05);
    const marked = [0.75, 0.8];
    const threshold = otsuThreshold([...blank, ...marked]);
    expect(threshold).toBeGreaterThan(0.05);
    expect(threshold).toBeLessThan(0.75);
  });
});
