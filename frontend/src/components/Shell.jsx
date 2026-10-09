import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Button } from './ui';

export default function Shell({ children, breadcrumb }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const leave = async () => {
    await logout();
    navigate('/', { replace: true });
  };

  return (
    <div className="grain min-h-screen">
      <header className="sticky top-0 z-40 border-b border-ink-600/70 bg-ink-900/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1180px] items-center gap-5 px-6 py-3.5">
          <Link to="/dashboard" className="group flex items-baseline gap-2" data-testid="brand-link">
            <span className="font-display text-base tracking-tight text-bone">REPÚBLICA</span>
            <span className="font-mono text-xs text-amarelo transition-transform duration-200 group-hover:translate-x-0.5">
              27
            </span>
          </Link>
          {breadcrumb && (
            <span className="hidden font-mono text-[11px] uppercase tracking-[0.16em] text-muted sm:block">
              / {breadcrumb}
            </span>
          )}
          <div className="ml-auto flex items-center gap-3">
            <Link
              to="/painel-ia"
              className="hidden font-mono text-[11px] uppercase tracking-[0.16em] text-muted transition-colors duration-200 hover:text-bone sm:block"
              data-testid="ai-check-link"
            >
              Teste de IA
            </Link>
            {user && (
              <span className="hidden font-mono text-[11px] text-muted sm:block" data-testid="session-email">
                {user.displayName || user.email}
              </span>
            )}
            <Button variant="ghost" onClick={leave} data-testid="logout-button">
              <LogOut size={13} />
              Sair
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1180px] px-6 py-8">{children}</main>
      <footer className="mx-auto max-w-[1180px] px-6 pb-10 pt-4">
        <p className="font-mono text-[11px] text-ink-500">
          Simulação determinística · motor TypeScript · PostgreSQL · event sourcing
        </p>
      </footer>
    </div>
  );
}
