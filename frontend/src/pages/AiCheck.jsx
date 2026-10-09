import React, { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import Shell from '../components/Shell';
import { Badge, Button, Field, Panel } from '../components/ui';
import { ai } from '../api/client';

const MESSAGES = {
  AI_NOT_CONFIGURED:
    'Integração pendente: cadastre sua chave pessoal do Gemini ou peça ao administrador para configurar a chave do projeto.',
  AI_AUTH_FAILED: 'O Google rejeitou a chave. Confira se ela está correta e ativa.',
  AI_DAILY_LIMIT_REACHED:
    'Você atingiu o limite diário da chave do projeto. Cadastre sua própria chave para continuar ou volte amanhã.',
  AI_TIMEOUT: 'O provedor demorou demais para responder. Tente novamente.',
  AI_PROVIDER_RATE_LIMITED: 'Muitas consultas ao provedor em pouco tempo. Aguarde um minuto.',
  AI_PROVIDER_ERROR: 'O provedor devolveu uma resposta inesperada. Tente novamente.',
  AI_PROVIDER_UNAVAILABLE: 'Provedor de IA indisponível no momento.',
  RATE_LIMITED: 'Muitas consultas em pouco tempo. Aguarde um minuto.',
  VALIDATION_ERROR: 'Confira os dados informados e tente novamente.',
};

const explain = (failure) =>
  failure instanceof TypeError
    ? 'Não foi possível conectar ao backend. Verifique o endereço da API.'
    : MESSAGES[failure.code] || 'Não foi possível concluir agora.';

export default function AiCheck() {
  const [status, setStatus] = useState(null);
  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMessage, setKeyMessage] = useState(null);
  const [keyError, setKeyError] = useState(null);

  const [prompt, setPrompt] = useState('Escreva uma frase de campanha sobre educação.');
  const [reply, setReply] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await ai.status();
      setStatus(result.ai);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const saveKey = async (event) => {
    event.preventDefault();
    if (keyBusy) return;
    setKeyBusy(true);
    setKeyError(null);
    setKeyMessage(null);
    try {
      const result = await ai.saveKey(keyInput.trim());
      setStatus(result.ai);
      setKeyInput('');
      setShowKey(false);
      setKeyMessage('Chave salva com segurança (criptografada no servidor).');
    } catch (failure) {
      setKeyError(explain(failure));
    } finally {
      setKeyBusy(false);
    }
  };

  const removeKey = async () => {
    if (keyBusy) return;
    setKeyBusy(true);
    setKeyError(null);
    setKeyMessage(null);
    try {
      const result = await ai.removeKey();
      setStatus(result.ai);
      setKeyMessage('Chave pessoal removida. Voltando a usar a chave do projeto.');
    } catch (failure) {
      setKeyError(explain(failure));
    } finally {
      setKeyBusy(false);
    }
  };

  const test = async (event) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setReply(null);
    setBusy(true);
    try {
      const result = await ai.ping(prompt);
      setReply(result);
      refresh();
    } catch (failure) {
      setError(explain(failure));
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const personal = status?.personalKey;
  const project = status?.defaultKey;
  const active = personal?.configured ? 'personal' : project?.available ? 'default' : 'none';

  return (
    <Shell breadcrumb="Teste de IA">
      <div className="mx-auto grid max-w-3xl gap-6">
        <Panel
          title="Qual chave do Gemini usar"
          hint="Duas opções: a chave do projeto (limite diário) ou a sua própria chave (sem esse limite)."
          action={
            <Badge
              tone={active === 'none' ? 'bad' : active === 'personal' ? 'good' : 'info'}
              testId="ai-active-source"
            >
              {active === 'personal' ? 'Em uso: sua chave' : active === 'default' ? 'Em uso: chave do projeto' : 'Sem chave disponível'}
            </Badge>
          }
          testId="ai-key-panel"
        >
          <div className="grid gap-5 md:grid-cols-2">
            <div className="border-l-2 border-ink-600 pl-3" data-testid="ai-project-key-info">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone">Chave do projeto</p>
              {project ? (
                project.available ? (
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    Gratuita para jogadores sem chave própria. Hoje: {project.usedToday} de{' '}
                    {project.dailyLimit} consultas usadas ({project.remainingToday} restantes).
                  </p>
                ) : (
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    Ainda não configurada pelo administrador. Use sua chave pessoal.
                  </p>
                )
              ) : (
                <p className="mt-1 text-xs text-muted">Carregando…</p>
              )}
            </div>

            <div className="border-l-2 border-ink-600 pl-3" data-testid="ai-personal-key-info">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone">Sua chave pessoal</p>
              {personal?.configured ? (
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <span className="font-mono text-xs text-muted" data-testid="ai-key-hint">
                    {personal.hint}
                  </span>
                  <Button variant="danger" onClick={removeKey} disabled={keyBusy} data-testid="ai-remove-key">
                    Remover
                  </Button>
                </div>
              ) : (
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Nenhuma chave cadastrada. Crie a sua em aistudio.google.com/apikey.
                </p>
              )}
            </div>
          </div>

          {status && !status.personalKeysEnabled && (
            <p className="mt-4 font-mono text-[11px] text-amarelo" data-testid="ai-personal-disabled">
              Chaves pessoais estão desativadas neste servidor (falta AI_KEY_ENCRYPTION_SECRET).
            </p>
          )}

          {status?.personalKeysEnabled && (
            <form onSubmit={saveKey} className="mt-5 space-y-3" data-testid="ai-key-form">
              <div className="relative">
                <Field
                  label={personal?.configured ? 'Substituir chave pessoal' : 'Cadastrar chave pessoal'}
                  type={showKey ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  value={keyInput}
                  onChange={(event) => setKeyInput(event.target.value)}
                  hint="Guardada criptografada no servidor. Nunca é exibida de volta."
                  data-testid="ai-key-input"
                />
                <button
                  type="button"
                  aria-label={showKey ? 'Ocultar a chave' : 'Mostrar a chave'}
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-2 top-[26px] rounded-sm p-1 text-muted transition-colors duration-200 hover:text-bone"
                >
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <Button type="submit" variant="solid" disabled={keyBusy || keyInput.trim().length < 20} data-testid="ai-save-key">
                {keyBusy ? 'Salvando…' : 'Salvar chave'}
              </Button>
            </form>
          )}

          {keyError && (
            <p className="mt-3 font-mono text-[11px] text-sangue" data-testid="ai-key-error">
              {keyError}
            </p>
          )}
          {keyMessage && (
            <p className="mt-3 font-mono text-[11px] text-verde" data-testid="ai-key-message">
              {keyMessage}
            </p>
          )}
        </Panel>

        <Panel
          title="Verificação da integração Gemini"
          hint="Envia um pedido curto ao provedor pelo backend e devolve a resposta gerada."
          testId="ai-check-panel"
        >
          <form onSubmit={test} className="space-y-4">
            <label className="block">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Pedido</span>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={4}
                maxLength={1000}
                className="mt-1.5 w-full resize-y rounded-sm border border-ink-600 bg-ink-900/80 px-3 py-2 text-sm text-bone outline-none transition-colors duration-200 focus:border-amarelo"
                data-testid="ai-prompt-input"
              />
            </label>
            <Button type="submit" variant="primary" disabled={busy} data-testid="ai-test-button">
              {busy ? 'Consultando…' : 'Consultar o Gemini'}
            </Button>
          </form>

          {error && (
            <p className="mt-4 font-mono text-[11px] text-sangue" data-testid="ai-test-error">
              {error}
            </p>
          )}
          {reply && (
            <div className="mt-4 rounded-sm border border-ink-600 bg-ink-900/80 p-4" data-testid="ai-test-reply">
              <p className="text-sm leading-relaxed text-bone">{reply.reply}</p>
              <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
                modelo: {reply.model} · chave: {reply.source === 'personal' ? 'pessoal' : 'do projeto'}
              </p>
            </div>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
