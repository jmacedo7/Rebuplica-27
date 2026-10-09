/**
 * Gemini integration layer.
 *
 * The only place that talks to the Google Gemini API. The game engine never calls
 * this module implicitly: it is invoked by explicit API routes for narrative content
 * generation, and the deterministic domain stays the single source of truth for
 * game state (see docs/adr/0007-integracao-gemini.md).
 *
 * Security rules enforced here:
 * - the API key is passed as a `Secret` and never appears in errors or logs;
 * - every request has a timeout and a hard prompt size limit;
 * - provider failures map to stable, client-safe error codes;
 * - the fetcher is injectable so tests never call the real provider.
 */
import type { Secret } from '../config/index.ts';

export const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com';

export const MINIMUM_PROMPT_LENGTH = 3;
export const MAXIMUM_PROMPT_LENGTH = 1_000;

export type GeminiErrorCode =
  | 'AI_NOT_CONFIGURED'
  | 'AI_AUTH_FAILED'
  | 'AI_TIMEOUT'
  | 'AI_PROVIDER_RATE_LIMITED'
  | 'AI_PROVIDER_ERROR'
  | 'AI_PROVIDER_UNAVAILABLE';

/** Transport error with a stable code and a message safe for clients. */
export class GeminiError extends Error {
  readonly status: number;
  readonly code: GeminiErrorCode;
  constructor(status: number, code: GeminiErrorCode, message: string) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.code = code;
  }
}

export interface GeminiRequest {
  readonly url: string;
  readonly init: RequestInit;
}

export type GeminiFetcher = (request: GeminiRequest) => Promise<Response>;

export interface GeminiResult {
  readonly text: string;
  readonly model: string;
}

export interface GeminiOptions {
  /** Absent key means the integration is pending configuration, never a silent success. */
  readonly apiKey?: Secret<string> | undefined;
  readonly model: string;
  readonly timeoutMs: number;
  readonly baseUrl?: string | undefined;
  /** Injectable so tests never perform network calls. */
  readonly fetcher?: GeminiFetcher | undefined;
}

interface GeminiContentPart {
  readonly text?: string | undefined;
}

interface GeminiResponsePayload {
  readonly candidates?: ReadonlyArray<{
    readonly content?: { readonly parts?: readonly GeminiContentPart[] } | undefined;
  }> | undefined;
}

export const validateGeminiPrompt = (prompt: string): string => {
  const trimmed = prompt.trim();
  if (trimmed.length < MINIMUM_PROMPT_LENGTH) {
    throw new GeminiError(400,'AI_PROVIDER_ERROR',`prompt must contain at least ${MINIMUM_PROMPT_LENGTH} characters`);
  }
  if (trimmed.length > MAXIMUM_PROMPT_LENGTH) {
    throw new GeminiError(400,'AI_PROVIDER_ERROR',`prompt must contain at most ${MAXIMUM_PROMPT_LENGTH} characters`);
  }
  return trimmed;
};

const replyText = (payload: GeminiResponsePayload): string => {
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map(part => part.text ?? '').join('').trim();
  return text;
};

export class GeminiService {
  readonly #options: GeminiOptions;
  readonly #fetcher: GeminiFetcher;

  constructor(options: GeminiOptions) {
    this.#options = options;
    this.#fetcher = options.fetcher ?? (request => fetch(request.url,request.init));
  }

  get model(): string {
    return this.#options.model;
  }

  /** Generates one text completion for a validated, size limited prompt. */
  async generate(rawPrompt: string): Promise<GeminiResult> {
    const apiKey = this.#options.apiKey;
    if (apiKey === undefined) {
      throw new GeminiError(
        503,
        'AI_NOT_CONFIGURED',
        'A integração com o Gemini ainda não foi configurada: cadastre GEMINI_API_KEY no ambiente do backend',
      );
    }
    const prompt = validateGeminiPrompt(rawPrompt);
    const url = `${this.#options.baseUrl ?? GEMINI_API_BASE_URL}/v1beta/models/${encodeURIComponent(this.#options.model)}:generateContent`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),this.#options.timeoutMs);
    try {
      const response = await this.#fetcher({
        url,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Key in a header, never in the URL or the body.
            'x-goog-api-key': apiKey.reveal(),
          },
          body: JSON.stringify({contents: [{parts: [{text: prompt}]}]}),
          signal: controller.signal,
        },
      });
      if (response.status === 401 || response.status === 403) {
        throw new GeminiError(503,'AI_AUTH_FAILED','O provedor de IA rejeitou a credencial; verifique a GEMINI_API_KEY');
      }
      if (response.status === 429) {
        throw new GeminiError(429,'AI_PROVIDER_RATE_LIMITED','O provedor de IA está limitando as requisições; tente novamente em instantes');
      }
      if (!response.ok) {
        throw new GeminiError(503,'AI_PROVIDER_UNAVAILABLE','O provedor de IA está indisponível no momento');
      }
      let payload: GeminiResponsePayload;
      try {
        payload = await response.json() as GeminiResponsePayload;
      } catch {
        throw new GeminiError(503,'AI_PROVIDER_ERROR','O provedor de IA devolveu uma resposta ilegível');
      }
      const text = replyText(payload);
      if (text === '') {
        throw new GeminiError(503,'AI_PROVIDER_ERROR','O provedor de IA devolveu uma resposta vazia');
      }
      return {text,model: this.#options.model};
    } catch (error) {
      if (error instanceof GeminiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new GeminiError(504,'AI_TIMEOUT','O provedor de IA demorou demais para responder');
      }
      throw new GeminiError(503,'AI_PROVIDER_UNAVAILABLE','Não foi possível comunicar com o provedor de IA');
    } finally {
      clearTimeout(timer);
    }
  }
}
