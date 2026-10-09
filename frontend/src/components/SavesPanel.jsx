import React, { useState } from 'react';
import { Archive, RotateCcw } from 'lucide-react';
import { Badge, Button, Empty } from './ui';

export default function SavesPanel({ saves, onCreate, onRestore }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const guard = async (label, operation) => {
    setBusy(label);
    setError(null);
    try {
      await operation();
    } catch (failure) {
      const messages = {
        SAVE_CONFLICT: 'Já existe um save nesta versão. Avance o turno ou decida algo antes.',
        CONFLICT: 'A partida mudou durante a operação. Recarregue.',
      };
      setError(messages[failure.code] || 'Operação de save falhou.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <Button
        variant="solid"
        disabled={busy === 'create'}
        onClick={() => guard('create', onCreate)}
        data-testid="create-save-button"
      >
        <Archive size={14} />
        {busy === 'create' ? 'Salvando…' : 'Gravar save'}
      </Button>

      {error && (
        <p className="font-mono text-[11px] text-sangue" data-testid="save-error">
          {error}
        </p>
      )}

      {saves === null && <Empty>Carregando…</Empty>}
      {saves !== null && saves.length === 0 && <Empty>Nenhum save gravado.</Empty>}

      <ul className="divide-y divide-ink-700">
        {(saves || []).map((save) => (
          <li
            key={save.id}
            className="flex items-center gap-3 py-2.5"
            data-testid={`save-row-${save.version}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-bone">versão {save.version}</span>
                <Badge>turno {save.turn}</Badge>
              </div>
              <p className="mt-0.5 font-mono text-[11px] text-muted">
                {new Date(save.worldDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
              </p>
            </div>
            <Button
              variant="ghost"
              disabled={busy === save.id}
              onClick={() => guard(save.id, () => onRestore(save.id))}
              data-testid={`restore-save-${save.version}`}
            >
              <RotateCcw size={13} />
              Restaurar
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
