// CloudWatch Synthetics heartbeat for Learnix. Each step is one HTTP check; a non-2xx status or a
// missing marker fails the step (and the canary run). Configuration comes from environment
// variables set by Terraform: API_URL, FRONTEND_URL and CHECKS (JSON array of {name, path, target, expect});
// target "frontend" checks the Vercel-hosted site, anything else the API host.
const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');

const apiUrl = new URL(process.env.API_URL);
const frontendUrl = new URL(process.env.FRONTEND_URL);
const checks = JSON.parse(process.env.CHECKS || '[]');

const runCheck = async (check) => {
  const url = new URL(check.path, check.target === 'frontend' ? frontendUrl : apiUrl);
  const request = {
    hostname: url.hostname,
    method: 'GET',
    path: url.pathname + url.search,
    port: 443,
    protocol: 'https:',
    headers: { 'User-Agent': `${synthetics.getCanaryUserAgentString()} learnix-canary` },
  };

  const validate = (res) =>
    new Promise((resolve, reject) => {
      if (res.statusCode < 200 || res.statusCode > 299) {
        reject(new Error(`${check.name}: HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', (chunk) => {
        if (body.length < 512 * 1024) body += chunk;
      });
      res.on('end', () => {
        if (check.expect && !body.includes(check.expect)) {
          reject(new Error(`${check.name}: response does not contain "${check.expect}"`));
          return;
        }
        resolve();
      });
    });

  await synthetics.executeHttpStep(check.name, request, validate, {
    includeRequestHeaders: false,
    includeResponseHeaders: true,
    includeRequestBody: false,
    includeResponseBody: false,
  });
};

exports.handler = async () => {
  log.info(`Checking ${checks.length} endpoints on ${apiUrl.origin} and ${frontendUrl.origin}`);
  for (const check of checks) {
    await runCheck(check);
  }
};
