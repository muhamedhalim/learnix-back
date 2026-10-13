import type { ConfigService } from '@nestjs/config';

import { VideoConfig } from './video.config';

const configOf = (values: Record<string, string>): VideoConfig =>
  new VideoConfig({ get: (key: string) => values[key] } as unknown as ConfigService);

describe('VideoConfig.publicOrigin (frontend on Vercel, API/CDN on its own host)', () => {
  it('prefers VIDEO_PUBLIC_ORIGIN and strips trailing slashes', () => {
    const cfg = configOf({
      VIDEO_PUBLIC_ORIGIN: 'https://api.learnix.school/',
      BACKEND_URL: 'https://other.example.test',
      FRONTEND_URL: 'https://learnix.school',
    });
    expect(cfg.publicOrigin).toBe('https://api.learnix.school');
  });

  it('falls back to BACKEND_URL, never to the frontend origin (signed cookies are host-only cookies of the API host)', () => {
    const cfg = configOf({ BACKEND_URL: 'https://api.learnix.school', FRONTEND_URL: 'https://learnix.school' });
    expect(cfg.publicOrigin).toBe('https://api.learnix.school');
  });

  it('is empty (playback unconfigured) when neither is set, even if only the frontend origin is known', () => {
    expect(configOf({ FRONTEND_URL: 'https://learnix.school' }).publicOrigin).toBe('');
  });
});
