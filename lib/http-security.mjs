// Guards state-changing (POST) requests against cross-origin submission.
// Browsers attach an Origin header to same-site POSTs; we only accept the
// request if that Origin matches this server's own address.
export function isTrustedOrigin(request, { host, port }) {
  const origin = request.headers.origin;
  if (!origin) return false;

  const allowed = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://${host}:${port}`,
  ]);

  return allowed.has(origin);
}
