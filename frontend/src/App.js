import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import AiCheck from './pages/AiCheck';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import Match from './pages/Match';

const Loading = () => (
  <div className="grain min-h-screen flex items-center justify-center" data-testid="app-loading">
    <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">carregando…</p>
  </div>
);

function Protected({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/" replace />;
  return children;
}

function Entry() {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (user) return <Navigate to="/dashboard" replace />;
  return <Login />;
}

function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<Entry />} />
      <Route
        path="/dashboard"
        element={
          <Protected>
            <Dashboard />
          </Protected>
        }
      />
      <Route
        path="/partida/:id"
        element={
          <Protected>
            <Match />
          </Protected>
        }
      />
      <Route
        path="/painel-ia"
        element={
          <Protected>
            <AiCheck />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRouter />
    </AuthProvider>
  );
}
