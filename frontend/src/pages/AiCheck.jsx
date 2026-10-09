import React, { useState } from 'react';
import Shell from '../components/Shell';
import { Button, Panel } from '../components/ui';
import { ai } from '../api/client';

const MESSAGES = {
  AI_NOT_CONFIGURED:
    'Integração pendente: a GEMINI_API_KEY ainda não foi cadastrada no ambiente do backend.',
  AI_AUTH_FAILED: 'O provedor rejeitou a chave. Verifique a GEMINI_API_KEY cadastrada.',
  AI_TIMEOUT: 'O provedor demorou demais para responder. Tente novamente.',
  AI_PROVIDER_RATE_LIMITED: 'Muitas consultas ao provedor em pouco tempo. Aguarde um minuto.',
  AI_PROVIDER_ERROR: 'O provedor devolveu uma resposta inesperada. Tente novamente.',
  AI_PROVIDER_UNAVAILABLE: 'Provedor de IA indisponível no momento.',
  RATE_LIMITED: 'Muitas consultas em pouco tempo. Aguarde um minuto.',
  VALIDATION_ERROR: 'Use um pedido de 3 a 1000 caracteres.',
};

export default function AiCheck() {
  const [prompt, setPrompt] = useState('Escreva uma frase de campanha sobre educação.');
  const [reply, setReply] = useState(null);
  const [model, setModel] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const test = async (event) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setReply(null);
    setModel(null);
    setBusy(true);
    try {
      const result = await ai.ping(prompt);
      setReply(result.reply);
      setModel(result.model);
    } catch (failure) {
      setError(
        failure instanceof TypeError
          ? 'Não foi possível conectar ao backend. Verifique o endereço da API.'
          : MESSAGES[failure.code] || 'Não foi possível consultar o Gemini agora.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell breadcrumb="Teste de IA">
      <div className="mx-auto max-w-2xl">
        <Panel
          title="Verificação da integração Gemini"
          hint="Envia um pedido curto ao provedor pelo backend e devolve a resposta gerada."
          testId="ai-check-panel"
        >
          <form onSubmit={test} className="space-y-4">
            <label className="block">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                Pedido
              </span>
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
              <p className="text-sm leading-relaxed text-bone">{reply}</p>
              {model && (
                <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
                  modelo: {model}
                </p>
              )}
            </div>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
