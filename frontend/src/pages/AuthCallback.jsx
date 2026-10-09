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
        const { user } = await auth.exchangeSession(sessionId);
        setUser(user);
        window.history.replaceState(null, '', '/dashboard');
        navigate('/dashboard', { replace: true, state: { user } });
      } catch {
        window.history.replaceState(null, '', '/');
        navigate('/', { replace: true });
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
