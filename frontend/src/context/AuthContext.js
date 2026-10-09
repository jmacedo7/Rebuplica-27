import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { auth, clearToken, storeToken } from '../api/client';

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const checkAuth = useCallback(async () => {
    try {
      const { user: current } = await auth.me();
      setUser(current);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // CRITICAL: coming back from OAuth, AuthCallback exchanges the session_id first.
    if (window.location.hash?.includes('session_id=')) {
      setLoading(false);
      return;
    }
    checkAuth();
  }, [checkAuth]);

  const loginWithPassword = async (email, password) => {
    const result = await auth.login(email, password);
    storeToken(result.accessToken);
    setUser(result.user);
    return result.user;
  };

  const registerWithPassword = async (email, password) => {
    await auth.register(email, password);
    return loginWithPassword(email, password);
  };

  const logout = async () => {
    try {
      await auth.logout();
    } catch {
      // a logout must always clear the local state
    }
    clearToken();
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, setUser, checkAuth, loginWithPassword, registerWithPassword, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}
