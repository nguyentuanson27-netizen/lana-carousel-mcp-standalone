export function safeReturnTo(candidate, requestOrigin, allowedPaths, fallback = "/") {
  const allowed = new Set(allowedPaths || []);
  try {
    const origin = new URL(requestOrigin);
    const raw = String(candidate || "");
    if (!raw || raw.includes("\\") || /%5c/iu.test(raw) || /^[\\/]{2}/u.test(raw)) return fallback;
    const target = new URL(raw, origin);
    if (target.origin !== origin.origin || !allowed.has(target.pathname)) return fallback;
    return `${target.pathname}${target.search}`;
  } catch {
    return fallback;
  }
}
