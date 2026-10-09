/**
 * Emergent-managed Google login.
 *
 * The browser is sent to `auth.emergentagent.com` and comes back with a one-shot
 * `session_id` in the URL fragment. Only the server may exchange it: this module
 * is the single place that talks to the Emergent auth service.
 */
import { unauthorized } from './errors.ts';

export const EMERGENT_SESSION_DATA_URL =
  'https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data';

export interface OAuthProfile {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly picture: string | null;
  readonly sessionToken: string;
}

export type OAuthProfileFetcher = (sessionId: string) => Promise<OAuthProfile>;

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** Exchanges a one-shot `session_id` for the signed-in profile and session token. */
export const fetchEmergentProfile: OAuthProfileFetcher = async sessionId => {
  const response = await fetch(EMERGENT_SESSION_DATA_URL,{
    method:'GET',
    headers:{'X-Session-ID':sessionId},
  });
  if (!response.ok) throw unauthorized('Invalid or expired OAuth session');
  const payload = (await response.json()) as Record<string,unknown>;
  const email = readString(payload['email']);
  const sessionToken = readString(payload['session_token']);
  const id = readString(payload['id']);
  if (email === null || sessionToken === null || id === null) throw unauthorized('Incomplete OAuth profile');
  return {
    id,
    email:email.toLowerCase(),
    name:readString(payload['name']),
    picture:readString(payload['picture']),
    sessionToken,
  };
};
