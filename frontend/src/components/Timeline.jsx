import React from 'react';
import { Badge, Empty } from './ui';

const LABELS = {
  GameCreated: ['Partida criada', 'info'],
  DecisionApplied: ['Decisão aplicada', 'warn'],
  TurnAdvanced: ['Turno avançado', 'good'],
  SaveRestored: ['Save restaurado', 'bad'],
};

const describe = (entry) => {
  if (entry.type === 'DecisionApplied') {
    const decision = entry.event?.decision;
    if (!decision) return '';
    return `${decision.type} · ${decision.payload?.key} = ${String(decision.payload?.value)}`;
  }
  if (entry.type === 'TurnAdvanced') return `+${entry.event?.days} dias · turno ${entry.event?.turn}`;
  if (entry.type === 'SaveRestored') return `voltou para a versão ${entry.event?.restoredFromVersion}`;
  return `semente ${entry.event?.state?.seed}`;
};

export default function Timeline({ events }) {
  if (events === null) return <Empty>Carregando…</Empty>;
  if (events.length === 0) return <Empty>Sem eventos.</Empty>;

  return (
    <ol className="relative space-y-0" data-testid="event-timeline">
      {[...events].reverse().map((entry) => {
        const [label, tone] = LABELS[entry.type] || [entry.type, 'neutral'];
        return (
          <li
            key={entry.eventId}
            className="relative border-l border-ink-600 pb-4 pl-5 last:pb-0"
            data-testid={`event-${entry.version}`}
          >
            <span className="absolute -left-[4.5px] top-1.5 h-2 w-2 rounded-full bg-ink-500" />
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] text-ink-500">v{entry.version}</span>
              <Badge tone={tone}>{label}</Badge>
            </div>
            <p className="mt-1 font-mono text-[11px] leading-relaxed text-muted">{describe(entry)}</p>
          </li>
        );
      })}
    </ol>
  );
}
