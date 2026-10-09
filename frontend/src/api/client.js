const BASE = `${process.env.REACT_APP_BACKEND_URL}/api`;

const TOKEN_KEY = 'rebuplica27.accessToken';

export const readToken = () => localStorage.getItem(TOKEN_KEY);
export const storeToken = (token) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const parse = async (response) => {
  const text = await response.text();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

export const api = async (path, { method = 'GET', body, headers = {} } = {}) => {
  const token = readToken();
  const response = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await parse(response);
  if (!response.ok) {
    const error = payload.error || {};
    throw new ApiError(response.status, error.code || 'UNKNOWN', error.message);
  }
  return payload;
};

export const auth = {
  me: () => api('/auth/me'),
  login: (email, password) => api('/auth/login', { method: 'POST', body: { email, password } }),
  register: (email, password) => api('/auth/register', { method: 'POST', body: { email, password } }),
  exchangeSession: (sessionId) => api('/auth/session', { method: 'POST', body: { session_id: sessionId } }),
  logout: () => api('/auth/logout', { method: 'POST', body: {} }),
};

export const games = {
  list: () => api('/games?limit=100'),
  create: (seed) => api('/games', { method: 'POST', body: seed === null ? {} : { seed } }),
  get: (id) => api(`/games/${id}`),
  decide: (id, type, payload) => api(`/games/${id}/decisions`, { method: 'POST', body: { type, payload } }),
  advance: (id, days) => api(`/games/${id}/turn`, { method: 'POST', body: { days } }),
  events: (id) => api(`/games/${id}/events?limit=200`),
  replay: (id) => api(`/games/${id}/replay`),
  saves: (id) => api(`/games/${id}/saves`),
  createSave: (id) => api(`/games/${id}/saves`, { method: 'POST', body: {} }),
  restore: (id, saveId) => api(`/games/${id}/saves/${saveId}/restore`, { method: 'POST', body: {} }),
};
