"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, errorMessage } from "@/lib/api";
import { AppProvider } from "@/lib/store";
import { Shell } from "@/components/Shell";
import { ErrorState, Loading, Skeleton } from "@/components/ui";
import { markSignedIn, wasSignedIn } from "@/lib/session";
import type { Me } from "@/lib/types";

export default function SignedInLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `returnHere`: come back to this page after signing in. True when the session
  // expired, or when an unauthenticated visitor followed a deep link (an alert
  // link to an incident). Never for a normal sign-out: on a shared device the
  // next person starts at the overview.
  const toLogin = useCallback(
    (expired: boolean, returnHere: boolean = expired) => {
      markSignedIn(false);
      const params = new URLSearchParams();
      if (expired) params.set("expired", "1");
      if (returnHere) {
        const here = window.location.pathname + window.location.search;
        if (here && here !== "/" && !here.startsWith("/login")) params.set("next", here);
      }
      const q = params.toString();
      router.replace(`/login/${q ? `?${q}` : ""}`);
    },
    [router],
  );
  const onSignedOut = useCallback((expired: boolean) => toLogin(expired), [toLogin]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const m = await api.get<Me>("/api/v1/me");
      markSignedIn(true);
      setMe(m);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) toLogin(wasSignedIn(), true);
      else setError(errorMessage(e));
    }
  }, [toLogin]);

  useEffect(() => {
    // Fetch-on-mount: loads from the API (an external system); state is only set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="center-page">
        <ErrorState title="Cannot load the dashboard" message={`${error} Monitoring status is unknown on this screen until it loads.`} onRetry={() => void load()} />
      </div>
    );
  }
  if (!me) {
    return (
      <div className="center-page">
        <Loading label="Signing in…">
          <Skeleton lines={4} height={20} />
        </Loading>
      </div>
    );
  }
  return (
    <AppProvider me={me} onSignedOut={onSignedOut}>
      <Shell>{children}</Shell>
    </AppProvider>
  );
}
