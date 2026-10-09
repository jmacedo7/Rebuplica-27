import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { auth } from '../api/client';

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
    checkAuth();
    // Any authenticated call that answers 401 (expired or revoked session)
    // clears the user so protected routes send the player back to the login.
    const onUnauthorized = () => setUser(null);
    window.addEventListener('rebuplica:unauthorized', onUnauthorized);
    return () => window.removeEventListener('rebuplica:unauthorized', onUnauthorized);
  }, [checkAuth]);

  const loginWithPassword = async (email, password) => {
    const result = await auth.login(email, password);
    // The server also sets the HttpOnly session cookie on this response.
    setUser(result.user);
    return result.user;
  };

  const registerWithPassword = async (email, password, displayName) => {
    await auth.register(email, password, displayName);
    return loginWithPassword(email, password);
  };

  const logout = async () => {
    try {
      await auth.logout();
    } catch {
      // logout must always clear the local state, even if the call fails
    }
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
