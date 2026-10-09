import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { Button, Field } from '../components/ui';
import { useAuth } from '../context/AuthContext';

const MESSAGES = {
  UNAUTHORIZED: 'E-mail ou senha incorretos.',
  EMAIL_ALREADY_EXISTS: 'Esse e-mail já tem conta. Use entrar.',
  WEAK_PASSWORD: 'A senha precisa de no mínimo 12 caracteres.',
  INVALID_EMAIL: 'E-mail inválido.',
  RATE_LIMITED: 'Muitas tentativas. Aguarde um minuto.',
  FORBIDDEN: 'O servidor bloqueou a origem desta página. Verifique a configuração de CORS.',
  SERVICE_UNAVAILABLE: 'O servidor ou o banco de dados está temporariamente indisponível.',
  VALIDATION_ERROR: 'Confira os dados e tente novamente.',
};

export default function Login() {
  const { loginWithPassword, registerWithPassword } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(() => location.state?.authError || null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const passwordFieldType = showPassword ? 'text' : 'password';

  const clientProblem = (failure) =>
    failure instanceof TypeError
      ? 'Não foi possível conectar à API. Verifique o endereço do backend e tente novamente.'
      : MESSAGES[failure.code] || failure.message || 'Não foi possível concluir. Tente novamente.';

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    if (mode === 'register' && password !== confirmation) {
      setError('As senhas não conferem.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        await loginWithPassword(email, password);
      } else {
        const displayName = name.trim() === '' ? undefined : name.trim();
        await registerWithPassword(email, password, displayName);
      }
      navigate('/dashboard', { replace: true });
    } catch (failure) {
      setError(clientProblem(failure));
    } finally {
      setBusy(false);
    }
  };

  const switchMode = () => {
    setMode(mode === 'login' ? 'register' : 'login');
    setError(null);
    setNotice(null);
    setConfirmation('');
    setShowPassword(false);
  };

  return (
    <div className="grain min-h-screen">
      <div className="mx-auto grid min-h-screen max-w-[1180px] gap-16 px-6 py-14 lg:grid-cols-[1.15fr_0.85fr] lg:py-24">
        <div className="rise max-w-xl">
          <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-amarelo">
            Simulador político · Brasil 2027
          </p>
          <h1 className="mt-6 font-display text-4xl leading-[1.05] tracking-tight text-bone sm:text-5xl lg:text-6xl">
            Rebuplica 27
          </h1>
          <p className="mt-6 max-w-lg text-base leading-relaxed text-muted">
            Um motor de simulação determinístico: cada decisão vira um evento imutável, cada
            partida pode ser rebobinada e auditada. Mesma semente, mesmo país.
          </p>
          <dl className="mt-12 grid max-w-md grid-cols-2 gap-x-8 gap-y-6">
            {[
              ['Determinismo', 'Semente fixa, RNG reprodutível'],
              ['Event sourcing', 'Histórico íntegro e verificável'],
              ['Saves atômicos', 'Snapshot por versão, sem perda'],
              ['Replay', 'Fingerprint SHA-256 do mundo'],
            ].map(([term, detail]) => (
              <div key={term} className="border-l-2 border-ink-600 pl-3">
                <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone">{term}</dt>
                <dd className="mt-1 text-xs leading-relaxed text-muted">{detail}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="rise self-center" style={{ animationDelay: '120ms' }}>
          <div className="rounded-sm border border-ink-600/70 bg-ink-800/80 p-7 shadow-panel">
            <h2 className="font-display text-base md:text-lg text-bone">
              {mode === 'login' ? 'Entrar no gabinete' : 'Criar cadastro'}
            </h2>
            <p className="mt-1 text-xs text-muted">Sua sessão guarda as partidas no servidor.</p>

            <form onSubmit={submit} className="mt-6 space-y-4" data-testid="password-auth-form">
              {mode === 'register' && (
                <Field
                  label="Nome (opcional)"
                  type="text"
                  maxLength={80}
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  data-testid="name-input"
                />
              )}
              <Field
                label="E-mail"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                data-testid="email-input"
              />
              <div className="relative">
                <Field
                  label="Senha"
                  type={passwordFieldType}
                  required
                  minLength={12}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  hint={mode === 'register' ? 'Mínimo de 12 caracteres.' : undefined}
                  data-testid="password-input"
                />
                <button
                  type="button"
                  aria-label={showPassword ? 'Ocultar a senha' : 'Mostrar a senha'}
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-[26px] rounded-sm p-1 text-muted transition-colors duration-200 hover:text-bone"
                  data-testid="password-visibility-toggle"
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              {mode === 'register' && (
                <Field
                  label="Confirmar senha"
                  type={passwordFieldType}
                  required
                  minLength={12}
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  data-testid="password-confirmation-input"
                />
              )}
              {error && (
                <p className="font-mono text-[11px] text-sangue" data-testid="auth-error">
                  {error}
                </p>
              )}
              {notice && (
                <p className="font-mono text-[11px] text-verde" data-testid="auth-notice">
                  {notice}
                </p>
              )}
              <Button
                type="submit"
                variant="solid"
                className="w-full py-2.5"
                disabled={busy}
                data-testid="submit-auth-button"
              >
                {busy ? 'Enviando…' : mode === 'login' ? 'Entrar' : 'Criar conta e entrar'}
              </Button>
            </form>

            <button
              type="button"
              onClick={switchMode}
              className="mt-5 font-mono text-[11px] text-muted underline decoration-ink-500 underline-offset-4 transition-colors duration-200 hover:text-bone"
              data-testid="toggle-auth-mode"
            >
              {mode === 'login' ? 'Não tenho conta — criar' : 'Já tenho conta — entrar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
