import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CalendarClock, ShieldCheck, ShieldAlert } from 'lucide-react';
import Shell from '../components/Shell';
import { Badge, Button, Empty, Panel, Stat } from '../components/ui';
import DecisionForm from '../components/DecisionForm';
import SavesPanel from '../components/SavesPanel';
import Timeline from '../components/Timeline';
import { games } from '../api/client';

const formatDate = (iso) =>
  new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: 'long', year: 'numeric' });

const TURN_OPTIONS = [30, 90, 365];

export default function Match() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState(null);
  const [events, setEvents] = useState(null);
  const [saves, setSaves] = useState(null);
  const [replay, setReplay] = useState(null);
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [current, history, saveList, integrity] = await Promise.all([
        games.get(id),
        games.events(id),
        games.saves(id),
        games.replay(id),
      ]);
      setGame(current.game);
      setEvents(history.events);
      setSaves(saveList.saves);
      setReplay(integrity.replay);
    } catch (failure) {
      if (failure.status === 404 || failure.status === 400) setMissing(true);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const applyDecision = async (type, payload) => {
    await games.decide(id, type, payload);
    await refresh();
  };

  const advance = async () => {
    setBusy(true);
    try {
      await games.advance(id, days);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (missing) {
    return (
      <Shell breadcrumb="partida">
        <Panel title="Partida não encontrada" testId="match-missing">
          <Empty>Essa partida não existe ou não é sua.</Empty>
          <Button variant="ghost" onClick={() => navigate('/dashboard')} data-testid="back-to-dashboard">
            Voltar ao gabinete
          </Button>
        </Panel>
      </Shell>
    );
  }

  if (game === null) {
    return (
      <Shell breadcrumb="partida">
        <Empty>Carregando partida…</Empty>
      </Shell>
    );
  }

  const world = game.state.world;
  const economy = Object.entries(world.economy);
  const society = Object.entries(world.society);
  const institutions = Object.entries(world.institutions);
  const flags = Object.entries(world.flags);

  return (
    <Shell breadcrumb={`partida ${game.id.slice(0, 8)}`}>
      <div className="rise flex flex-wrap items-end justify-between gap-6" data-testid="match-header">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amarelo">
            Turno {game.turn} · semente {game.seed}
          </p>
          <h1 className="mt-3 font-display text-3xl leading-tight tracking-tight text-bone sm:text-4xl">
            {formatDate(game.worldDate)}
          </h1>
          <p className="mt-2 font-mono text-[11px] text-muted" data-testid="match-version">
            versão {game.currentVersion} · {events?.length ?? 0} eventos registrados
          </p>
        </div>
        {replay && (
          <div className="flex items-center gap-2" data-testid="replay-status">
            {replay.consistent ? (
              <>
                <ShieldCheck size={16} className="text-verde" />
                <Badge tone="good">replay íntegro</Badge>
              </>
            ) : (
              <>
                <ShieldAlert size={16} className="text-sangue" />
                <Badge tone="bad">divergência na v{replay.firstMismatchVersion}</Badge>
              </>
            )}
            <span className="font-mono text-[10px] text-ink-500">{replay.fingerprint.slice(0, 12)}…</span>
          </div>
        )}
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
        <div className="space-y-6">
          <Panel title="Mundo" hint="Indicadores vigentes" testId="world-panel">
            {economy.length === 0 && society.length === 0 && institutions.length === 0 && (
              <Empty>Nenhum indicador definido. Assine a primeira decisão.</Empty>
            )}
            <div className="grid gap-5 sm:grid-cols-3">
              {[...economy, ...society, ...institutions].map(([key, value]) => (
                <Stat key={key} label={key} value={value} testId={`indicator-${key}`} />
              ))}
            </div>
            {flags.length > 0 && (
              <div className="mt-6 flex flex-wrap gap-2 border-t border-ink-700 pt-4">
                {flags.map(([key, value]) => (
                  <Badge key={key} tone={value ? 'good' : 'neutral'} testId={`flag-${key}`}>
                    {key} {value ? 'on' : 'off'}
                  </Badge>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Despacho" hint="Decisões alteram o estado e geram evento" testId="decision-panel">
            <DecisionForm onApply={applyDecision} />
          </Panel>

          <Panel title="Avançar o calendário" testId="turn-panel">
            <div className="flex flex-wrap items-center gap-3">
              <CalendarClock size={16} className="text-muted" />
              {TURN_OPTIONS.map((option) => (
                <Button
                  key={option}
                  variant={days === option ? 'primary' : 'ghost'}
                  onClick={() => setDays(option)}
                  data-testid={`turn-days-${option}`}
                >
                  {option} dias
                </Button>
              ))}
              <Button variant="solid" onClick={advance} disabled={busy} data-testid="advance-turn-button">
                {busy ? 'Avançando…' : 'Encerrar turno'}
              </Button>
            </div>
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title="Saves" hint="Um save por versão" testId="saves-panel">
            <SavesPanel
              saves={saves}
              onCreate={async () => {
                await games.createSave(id);
                await refresh();
              }}
              onRestore={async (saveId) => {
                await games.restore(id, saveId);
                await refresh();
              }}
            />
          </Panel>

          <Panel title="Diário oficial" hint="Histórico imutável" testId="timeline-panel">
            <Timeline events={events} />
          </Panel>
        </div>
      </div>
    </Shell>
  );
}
