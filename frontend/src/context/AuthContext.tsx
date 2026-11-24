import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError, getStoredToken, setStoredToken } from '../lib/api';
import type { UserProfile } from '../types';

const PROFILE_CACHE_KEY = 'lcr_user_profile_v1';

function loadCachedProfile(): UserProfile | null {
  try {
    if (!getStoredToken()) return null;
    const raw = localStorage.getItem(PROFILE_CACHE_KEY);
    return raw ? (JSON.parse(raw) as UserProfile) : null;
  } catch {
    return null;
  }
}

function saveCachedProfile(profile: UserProfile | null): void {
  try {
    if (profile) {
      localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile));
    } else {
      localStorage.removeItem(PROFILE_CACHE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

interface AuthContextValue {
  user: UserProfile | null;
  loading: boolean;
  authModalOpen: boolean;
  settingsModalOpen: boolean;
  uploadModalOpen: boolean;
  uploadTargetComic: { id: string; title: string } | null;
  openAuthModal: () => void;
  closeAuthModal: () => void;
  openSettingsModal: () => void;
  closeSettingsModal: () => void;
  openUploadModal: (target?: { id: string; title: string } | null) => void;
  closeUploadModal: () => void;
  refreshProfile: () => Promise<void>;
  loginSuccess: (token: string, profile: UserProfile) => void;
  logout: () => void;
  setUser: React.Dispatch<React.SetStateAction<UserProfile | null>>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<UserProfile | null>(() => loadCachedProfile());
  const [loading, setLoading] = useState(() => Boolean(getStoredToken() && !loadCachedProfile()));
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadTargetComic, setUploadTargetComic] = useState<{ id: string; title: string } | null>(null);

  const setUser: React.Dispatch<React.SetStateAction<UserProfile | null>> = useCallback(
    (updater) => {
      setUserState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        saveCachedProfile(next);
        return next;
      });
    },
    []
  );

  const refreshProfile = useCallback(async () => {
    const token = getStoredToken();
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const profile = await api.getMe();
      setUser(profile);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setStoredToken(null);
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, [setUser]);

  useEffect(() => {
    void refreshProfile();
  }, [refreshProfile]);

  const loginSuccess = useCallback(
    (token: string, profile: UserProfile) => {
      setStoredToken(token);
      setUser(profile);
      setAuthModalOpen(false);
    },
    [setUser]
  );

  const logout = useCallback(() => {
    setStoredToken(null);
    setUser(null);
  }, [setUser]);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        authModalOpen,
        settingsModalOpen,
        uploadModalOpen,
        uploadTargetComic,
        openAuthModal: () => setAuthModalOpen(true),
        closeAuthModal: () => setAuthModalOpen(false),
        openSettingsModal: () => setSettingsModalOpen(true),
        closeSettingsModal: () => setSettingsModalOpen(false),
        openUploadModal: (target = null) => {
          setUploadTargetComic(target);
          setUploadModalOpen(true);
        },
        closeUploadModal: () => {
          setUploadModalOpen(false);
          setUploadTargetComic(null);
        },
        refreshProfile,
        loginSuccess,
        logout,
        setUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
