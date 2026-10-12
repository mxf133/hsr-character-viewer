const ACCESS_TOKEN_KEYS = ['token', 'hsr-token', 'x-hsr-token', 'access_token', 'accessToken'];

const tokenFromPart = (part) => {
  if (!part) return '';
  const raw = String(part).replace(/^#/, '');
  const params = new URLSearchParams(raw);
  for (const key of ACCESS_TOKEN_KEYS) {
    const value = params.get(key)?.trim();
    if (value) return value;
  }
  return '';
};

let cachedToken = null;
let tokenRead = false;

export const readAccessToken = () => {
  if (tokenRead) return cachedToken;
  tokenRead = true;
  cachedToken = tokenFromPart(window.location.hash);
  if (cachedToken) {
    try {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    } catch { /* token remains usable for this page session */ }
  }
  return cachedToken;
};

export const accessHeaders = (headers = {}) => {
  const out = { ...headers };
  const token = readAccessToken();
  if (token && !out['x-hsr-token']) out['x-hsr-token'] = token;
  return out;
};
