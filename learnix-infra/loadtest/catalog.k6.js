// FR-331 / SC-013 load test through the real edge (CloudFront -> WAF -> ALB -> api).
//   k6 run -e BASE_URL=https://<staging site> loadtest/catalog.k6.js
// Prerequisites: the staging catalogue is seeded at scale (learnix-back: npm run seed:marketplace-load; 50,000
// courses / 500,000 enrollments), the load generator's address is on the WAF allowlist, and the WAF rate rules
// are in COUNT mode. Server-side latency is judged by the API's own timing (X-Response-Time / logs); k6 measures
// what a client behind the edge sees, which is the stricter number.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/$/, '');
if (!BASE_URL.startsWith('https://') && !BASE_URL.startsWith('http://localhost')) throw new Error('set -e BASE_URL=https://<site>');
const LEARNERS = Number(__ENV.LEARNERS || 500);
const INSTRUCTORS = Number(__ENV.INSTRUCTORS || 50);
const HOLD = __ENV.HOLD || '10m';

export const options = {
  scenarios: {
    learners: {
      executor: 'ramping-vus',
      exec: 'learner',
      startVUs: 0,
      stages: [
        { duration: '3m', target: LEARNERS },
        { duration: HOLD, target: LEARNERS },
        { duration: '1m', target: 0 },
      ],
    },
    ...(__ENV.INSTRUCTOR_TOKEN
      ? {
          // Instructors read their own (smaller, heavier) views; INSTRUCTOR_TOKEN is an access_token cookie value.
          instructors: { executor: 'constant-vus', exec: 'instructor', vus: INSTRUCTORS, duration: HOLD, startTime: '3m' },
        }
      : {}),
  },
  thresholds: {
    // FR-331: p95 <= 500 ms for list / search, <= 400 ms for detail.
    'http_req_duration{endpoint:list}': ['p(95)<500'],
    'http_req_duration{endpoint:search}': ['p(95)<500'],
    'http_req_duration{endpoint:detail}': ['p(95)<400'],
    'http_req_duration{endpoint:curriculum}': ['p(95)<400'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const res = http.get(`${BASE_URL}/api/v1/marketplace/courses?limit=20`);
  if (res.status !== 200) throw new Error(`catalogue not reachable (${res.status}); is the allowlist set?`);
  const items = res.json('items') || res.json('data.items') || [];
  if (items.length === 0) throw new Error('no published courses: seed the catalogue first');
  return { slugs: items.map((c) => c.slug || c.id) };
}

function get(path, endpoint) {
  const res = http.get(`${BASE_URL}${path}`, { tags: { endpoint } });
  check(res, { [`${endpoint} 200`]: (r) => r.status === 200 });
  return res;
}

export function learner(data) {
  const slug = data.slugs[Math.floor(Math.random() * data.slugs.length)];
  get('/api/v1/marketplace/courses', 'list');
  sleep(Math.random() * 2);
  get('/api/v1/marketplace/courses?q=Load&level=beginner&sort=newest', 'search');
  sleep(Math.random() * 2);
  get(`/api/v1/marketplace/courses/${slug}`, 'detail');
  get(`/api/v1/marketplace/courses/${slug}/curriculum`, 'curriculum');
  sleep(1 + Math.random() * 4);
}

export function instructor() {
  const res = http.get(`${BASE_URL}/api/v1/marketplace/instructor/courses`, {
    cookies: { access_token: __ENV.INSTRUCTOR_TOKEN },
    tags: { endpoint: 'instructor' },
  });
  check(res, { 'instructor 200': (r) => r.status === 200 });
  sleep(3 + Math.random() * 5);
}
