import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Dices, Plus } from 'lucide-react';
import Shell from '../components/Shell';
import { Badge, Button, Empty, Field, Panel } from '../components/ui';
import { games } from '../api/client';

const formatDate = (iso) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'UTC' });

export default function Dashboard() {
  const [matches, setMatches] = useState(null);
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  const load = async () => {
    try {
      const { games: list } = await games.list();
      setMatches(list);
    } catch {
      setMatches([]);
      setError('Não foi possível carregar suas partidas.');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const create = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const parsed = seed.trim() === '' ? null : Number(seed.trim());
      if (parsed !== null && (!Number.isInteger(parsed) || parsed < 0 || parsed > 4294967295)) {
        setError('A semente deve ser um inteiro entre 0 e 4.294.967.295.');
        setBusy(false);
        return;
      }
      const { game } = await games.create(parsed);
      navigate(`/partida/${game.id}`);
    } catch (failure) {
      const messages = {
        VALIDATION_ERROR: 'Semente rejeitada pelo servidor. Use um inteiro entre 0 e 4.294.967.295.',
        RATE_LIMITED: 'Muitas ações seguidas. Aguarde um minuto.',
        UNAUTHORIZED: 'Sua sessão expirou. Entre novamente.',
      };
      setError(messages[failure.code] || 'Não foi possível criar a partida.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell breadcrumb="gabinete">
      <div className="rise grid gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <h1 className="font-display text-4xl leading-tight tracking-tight text-bone sm:text-5xl">
            Suas partidas
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted">
            Cada partida é um mundo próprio, iniciado em 1º de janeiro de 2027. A semente fixa o
            RNG: repetir a semente e as mesmas decisões reproduz o país inteiro.
          </p>

          <Panel
            title="Nova partida"
            hint="Deixe a semente em branco para sortear."
            className="mt-8"
            testId="new-match-panel"
          >
            <form onSubmit={create} className="space-y-4">
              <Field
                label="Semente"
                inputMode="numeric"
                placeholder="aleatória"
                value={seed}
                onChange={(event) => setSeed(event.target.value)}
                data-testid="seed-input"
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="primary" disabled={busy} data-testid="create-match-button">
                  <Plus size={14} />
                  {busy ? 'Criando…' : 'Iniciar mandato'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setSeed(String(Math.floor(Math.random() * 4294967295)))}
                  data-testid="random-seed-button"
                >
                  <Dices size={14} />
                  Sortear
                </Button>
              </div>
              {error && (
                <p className="font-mono text-[11px] text-sangue" data-testid="dashboard-error">
                  {error}
                </p>
              )}
            </form>
          </Panel>
        </div>

        <Panel title="Histórico" hint="Mais recentes primeiro" testId="match-list-panel">
          {matches === null && <Empty>Carregando…</Empty>}
          {matches !== null && matches.length === 0 && <Empty>Nenhuma partida ainda.</Empty>}
          <ul className="divide-y divide-ink-700">
            {(matches || []).map((match) => (
              <li key={match.id}>
                <Link
                  to={`/partida/${match.id}`}
                  className="group flex items-center gap-4 py-3.5 transition-colors duration-200 hover:bg-ink-700/40"
                  data-testid={`match-row-${match.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5">
                      <span className="font-display text-base text-bone">Turno {match.turn}</span>
                      <Badge tone="info">semente {match.seed}</Badge>
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-muted">
                      mundo em {formatDate(match.worldDate)} · versão {match.currentVersion} ·{' '}
                      {match.id.slice(0, 8)}
                    </p>
                  </div>
                  <span className="font-mono text-[11px] text-muted transition-transform duration-200 group-hover:translate-x-1">
                    abrir →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </Shell>
  );
}
