import React, { useState } from 'react';
import { Button, Field } from './ui';

const TYPES = [
  { value: 'SET_ECONOMIC_INDICATOR', label: 'Indicador econômico', kind: 'number' },
  { value: 'SET_FLAG', label: 'Sinalizador de governo', kind: 'boolean' },
];

const SUGGESTIONS = {
  SET_ECONOMIC_INDICATOR: ['inflation', 'gdpGrowth', 'unemployment', 'selic', 'primarySurplus'],
  SET_FLAG: ['taxReformSent', 'stateOfEmergency', 'minimumWageRaised', 'congressCoalition'],
};

export default function DecisionForm({ onApply }) {
  const [type, setType] = useState(TYPES[0].value);
  const [key, setKey] = useState('inflation');
  const [numberValue, setNumberValue] = useState('4.2');
  const [flagValue, setFlagValue] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const kind = TYPES.find((entry) => entry.value === type).kind;

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      setError('A chave deve começar com letra e usar apenas letras, números e _.');
      return;
    }
    const value = kind === 'number' ? Number(numberValue) : flagValue;
    if (kind === 'number' && !Number.isFinite(value)) {
      setError('O valor deve ser um número finito.');
      return;
    }
    setBusy(true);
    try {
      await onApply(type, { key, value });
    } catch (failure) {
      const messages = {
        CONFLICT: 'Outra ação alterou a partida. Recarregue e tente novamente.',
        INVALID_DECISION: 'Decisão rejeitada pelo domínio.',
        VALIDATION_ERROR: 'Payload inválido.',
      };
      setError(messages[failure.code] || 'Não foi possível aplicar a decisão.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="decision-form">
      <label className="block">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Tipo</span>
        <select
          value={type}
          onChange={(event) => {
            setType(event.target.value);
            setKey(SUGGESTIONS[event.target.value][0]);
          }}
          className="mt-1.5 w-full rounded-sm border border-ink-600 bg-ink-900/80 px-3 py-2 text-sm text-bone outline-none focus:border-amarelo"
          data-testid="decision-type-select"
        >
          {TYPES.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>

      <Field
        label="Chave"
        value={key}
        onChange={(event) => setKey(event.target.value)}
        list="decision-keys"
        data-testid="decision-key-input"
      />
      <datalist id="decision-keys">
        {SUGGESTIONS[type].map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>

      {kind === 'number' ? (
        <Field
          label="Valor"
          inputMode="decimal"
          value={numberValue}
          onChange={(event) => setNumberValue(event.target.value)}
          data-testid="decision-value-input"
        />
      ) : (
        <div>
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Valor</span>
          <div className="mt-1.5 flex gap-2">
            {[true, false].map((option) => (
              <Button
                key={String(option)}
                type="button"
                variant={flagValue === option ? 'primary' : 'ghost'}
                onClick={() => setFlagValue(option)}
                data-testid={`decision-flag-${option}`}
              >
                {option ? 'verdadeiro' : 'falso'}
              </Button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <p className="font-mono text-[11px] text-sangue" data-testid="decision-error">
          {error}
        </p>
      )}

      <Button type="submit" variant="primary" disabled={busy} data-testid="apply-decision-button">
        {busy ? 'Aplicando…' : 'Assinar decisão'}
      </Button>
    </form>
  );
}
