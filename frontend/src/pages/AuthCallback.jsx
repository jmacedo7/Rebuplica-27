import React, { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { auth } from '../api/client';
import { useAuth } from '../context/AuthContext';

export default function AuthCallback() {
  const location = useLocation();
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const hasProcessed = useRef(false);

  useEffect(() => {
    if (hasProcessed.current) return;
    hasProcessed.current = true;
    const sessionId = new URLSearchParams(location.hash.replace(/^#/, '')).get('session_id');
    const run = async () => {
      try {
        if (!sessionId) throw new Error('MISSING_OAUTH_SESSION');
        const { user } = await auth.exchangeSession(sessionId);
        setUser(user);
        window.history.replaceState(null, '', '/dashboard');
        navigate('/dashboard', { replace: true, state: { user } });
      } catch (failure) {
        const authError = failure instanceof TypeError
          ? 'Não foi possível conectar à API para validar o login do Google.'
          : failure?.code === 'FORBIDDEN'
            ? 'O servidor bloqueou a origem deste preview. Verifique a configuração de CORS.'
            : failure?.code === 'UNAUTHORIZED' || failure?.message === 'MISSING_OAUTH_SESSION'
              ? 'A sessão do Google expirou ou não foi recebida. Tente entrar novamente.'
              : 'Não foi possível concluir o login com Google. Tente novamente.';
        window.history.replaceState(null, '', '/');
        navigate('/', { replace: true, state: { authError } });
      }
    };
    run();
  }, [location.hash, navigate, setUser]);

  return (
    <div className="min-h-screen flex items-center justify-center" data-testid="auth-callback">
      <p className="font-mono text-sm text-muted">Validando sessão…</p>
    </div>
  );
}
