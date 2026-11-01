'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Recheck when returning from the settings/login tab without losing the chart. */
export function useAiSession() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const requestRef = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setChecking(true);
    try {
      const response = await fetch('/api/admin/session', { cache: 'no-store', signal: controller.signal });
      const body = await response.json();
      if (!controller.signal.aborted) setAuthenticated(response.ok && body.authenticated === true);
    } catch {
      if (!controller.signal.aborted) setAuthenticated(false);
    } finally {
      if (requestRef.current === controller && !controller.signal.aborted) setChecking(false);
    }
  }, []);
  const requireLogin = useCallback(() => {
    requestRef.current?.abort();
    setAuthenticated(false);
    setChecking(false);
  }, []);
  useEffect(() => {
    void refresh();
    window.addEventListener('focus', refresh);
    return () => {
      requestRef.current?.abort();
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);
  return { authenticated, checking, refresh, requireLogin };
}
