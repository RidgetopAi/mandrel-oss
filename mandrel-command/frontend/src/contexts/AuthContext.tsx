import React, { createContext, useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { message } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { useLogin, useLogout, useAuthCheck, resetAuthState } from '../hooks/useAuth';
import { useAuth, useAuthStore } from '../stores/authStore';
import { LoginRequest } from '../api/generated/models/LoginRequest';
import { User } from '../api/generated/models/User';
import { logger } from '../utils/logger';

interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (credentials: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export const useAuthContext = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuthContext must be used within AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: React.ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const authStore = useAuth();
  const loginMutation = useLogin();
  const logoutMutation = useLogout();
  const { user, isAuthenticated, isLoading: checkingAuth, hasValidToken } = useAuthCheck();
  const [isInitialized, setIsInitialized] = useState(false);

  // Initialize auth state only once
  useEffect(() => {
    if (!isInitialized) {
      authStore.initialize();
      setIsInitialized(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInitialized]); // Intentionally omit authStore to prevent infinite loop

  // R3 — completed, idempotent self-heal. Whenever there is no valid token but
  // authed residue survives (a lingering persisted store, a stale cached
  // profile, or leftover localStorage keys), perform the SAME full reset manual
  // Logout does and route to a clean /login. This is what makes every
  // silent-mismatch path (24h expiry, cleared token, token loss mid-session)
  // recover automatically instead of stranding the user on an authed shell that
  // 401s on everything.
  //
  // Idempotent / no-loop: after the reset there is no residue left, and the
  // `pathname !== '/login'` guard means once we're on /login nothing re-fires.
  // Gate on `isInitialized` so we don't fight the one-time initialize() above.
  useEffect(() => {
    if (!isInitialized || hasValidToken) {
      return;
    }

    const hasResidue =
      !!localStorage.getItem('aidis_token') ||
      !!localStorage.getItem('aidis_user') ||
      !!localStorage.getItem('aidis-auth') ||
      useAuthStore.getState().isAuthenticated;

    if (hasResidue) {
      logger.warn('Auth self-heal: no valid token but authed residue present — resetting');
      resetAuthState(queryClient);
    }

    if (window.location.pathname !== '/login') {
      navigate('/login', { replace: true });
    }
  }, [isInitialized, hasValidToken, queryClient, navigate]);

  // Clean up token conflicts only once
  useEffect(() => {
    localStorage.removeItem('auth-token');
  }, []);

  // Memoize callbacks to prevent unnecessary re-renders
  const login = React.useCallback(async (credentials: LoginRequest) => {
    try {
      authStore.clearError();
      await loginMutation.mutateAsync(credentials);

      // Get user info for welcome message
      const userData = loginMutation.data?.user;
      const displayName = userData?.username || 'User';
      message.success(`Welcome back, ${displayName}!`);
    } catch (error: any) {
      const errorMessage = error?.body?.message || error?.message || 'Login failed';
      authStore.setError(errorMessage);
      message.error(errorMessage);
      throw error;
    }
  }, [authStore, loginMutation]);

  const logout = React.useCallback(async () => {
    try {
      await logoutMutation.mutateAsync();
      message.info('Logged out successfully');
      // Explicitly navigate to login page after logout
      navigate('/login', { replace: true });
    } catch (error) {
      logger.error('Logout error:', error);
      // Even if logout fails, clear local state and redirect
      message.info('Logged out successfully');
      navigate('/login', { replace: true });
    }
  }, [logoutMutation, navigate]);

  const clearError = React.useCallback(() => {
    authStore.clearError();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Intentionally empty - authStore.clearError is stable

  // Determine loading state
  const isLoading = !isInitialized || checkingAuth || loginMutation.isPending || logoutMutation.isPending;

  // Memoize context value to prevent unnecessary re-renders
  const contextValue: AuthContextType = React.useMemo(() => ({
    user: user as User | null,
    token: authStore.token,
    isAuthenticated,
    isLoading,
    error: authStore.error,
    login,
    logout,
    clearError,
  }), [user, authStore.token, isAuthenticated, isLoading, authStore.error, login, logout, clearError]);

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
};