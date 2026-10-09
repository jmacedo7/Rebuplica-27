/**
 * Chooses which Gemini key serves a request and enforces the usage policy.
 *
 * Order of preference:
 *  1. the player's own key (stored encrypted) - no project limit applies;
 *  2. the shared project key - limited per player per UTC day (free tier policy).
 *
 * The AI only produces text. It never writes game state: that stays with the
 * deterministic engine behind its own validations.
 */
import { GeminiError,type GeminiService } from '../ai/gemini.ts';
import { Secret } from '../config/index.ts';
import type { UserId } from '../domain/core/types.ts';
import type { Persistence } from '../persistence/index.ts';
import { SecretBox,SecretBoxError } from '../security/secret-box.ts';

export const MINIMUM_PERSONAL_KEY_LENGTH = 20;
export const MAXIMUM_PERSONAL_KEY_LENGTH = 200;

export type AiKeySource = 'personal' | 'default';

export interface AiKeyStatus {
  readonly personalKey: { readonly configured: boolean; readonly hint: string | null };
  readonly defaultKey: {
    readonly available: boolean;
    readonly dailyLimit: number;
    readonly usedToday: number;
    readonly remainingToday: number;
  };
  readonly personalKeysEnabled: boolean;
}

export interface AiReply {
  readonly text: string;
  readonly model: string;
  readonly source: AiKeySource;
}

export interface AiServiceOptions {
  readonly gemini: GeminiService;
  readonly persistence: Persistence;
  readonly dailyLimit: number;
  readonly encryptionSecret?: Secret<string> | undefined;
}

/** `AIza…abcd` style preview that never reveals the key. */
export const maskKey = (key: string): string => `${key.slice(0,4)}…${key.slice(-4)}`;

export class AiService {
  readonly #gemini: GeminiService;
  readonly #persistence: Persistence;
  readonly #dailyLimit: number;
  readonly #box: SecretBox | null;

  constructor(options: AiServiceOptions) {
    this.#gemini = options.gemini;
    this.#persistence = options.persistence;
    this.#dailyLimit = options.dailyLimit;
    this.#box = options.encryptionSecret === undefined ? null : new SecretBox(options.encryptionSecret.reveal());
  }

  get model(): string {
    return this.#gemini.model;
  }

  async status(userId: UserId): Promise<AiKeyStatus> {
    const stored = await this.#persistence.aiKeys.find(userId);
    const used = await this.#persistence.aiUsage.countToday(userId);
    return {
      personalKeysEnabled: this.#box !== null,
      personalKey: {configured: stored !== null,hint: stored?.keyHint ?? null},
      defaultKey: {
        available: this.#gemini.hasDefaultKey,
        dailyLimit: this.#dailyLimit,
        usedToday: used,
        remainingToday: Math.max(0,this.#dailyLimit - used),
      },
    };
  }

  /** Stores the player's key encrypted. The plaintext is not kept or logged. */
  async saveKey(userId: UserId,rawKey: string): Promise<AiKeyStatus> {
    if (this.#box === null) {
      throw new GeminiError(503,'AI_NOT_CONFIGURED','Chaves pessoais estão desativadas: o administrador precisa definir AI_KEY_ENCRYPTION_SECRET');
    }
    const key = rawKey.trim();
    if (key.length < MINIMUM_PERSONAL_KEY_LENGTH || key.length > MAXIMUM_PERSONAL_KEY_LENGTH || /\s/u.test(key)) {
      throw new GeminiError(400,'AI_PROVIDER_ERROR','A chave informada tem um formato inválido');
    }
    await this.#persistence.aiKeys.upsert(userId,this.#box.encrypt(key),maskKey(key));
    return this.status(userId);
  }

  async removeKey(userId: UserId): Promise<AiKeyStatus> {
    await this.#persistence.aiKeys.remove(userId);
    return this.status(userId);
  }

  async #personalKey(userId: UserId): Promise<Secret<string> | null> {
    if (this.#box === null) return null;
    const stored = await this.#persistence.aiKeys.find(userId);
    if (stored === null) return null;
    try {
      return new Secret(this.#box.decrypt(stored.encryptedKey));
    } catch (error) {
      if (error instanceof SecretBoxError) {
        throw new GeminiError(503,'AI_AUTH_FAILED','Não foi possível usar a chave pessoal salva; cadastre-a novamente');
      }
      throw error;
    }
  }

  /** Generates text with the player's key when present, otherwise the limited project key. */
  async generate(userId: UserId,prompt: string): Promise<AiReply> {
    const personal = await this.#personalKey(userId);
    if (personal !== null) {
      const result = await this.#gemini.generate(prompt,personal);
      return {text: result.text,model: result.model,source: 'personal'};
    }
    if (!this.#gemini.hasDefaultKey) {
      throw new GeminiError(503,'AI_NOT_CONFIGURED','A integração com o Gemini ainda não foi configurada: cadastre sua chave pessoal ou peça ao administrador para definir GEMINI_API_KEY');
    }
    const reserved = await this.#persistence.aiUsage.tryConsume(userId,this.#dailyLimit);
    if (!reserved) {
      throw new GeminiError(429,'AI_DAILY_LIMIT_REACHED',`Você atingiu o limite diário de ${this.#dailyLimit} consultas com a chave do projeto. Cadastre sua própria chave para continuar ou volte amanhã`);
    }
    try {
      const result = await this.#gemini.generate(prompt);
      return {text: result.text,model: result.model,source: 'default'};
    } catch (error) {
      // The provider produced no content: do not charge the player's daily allowance.
      await this.#persistence.aiUsage.release(userId).catch(() => undefined);
      throw error;
    }
  }
}
