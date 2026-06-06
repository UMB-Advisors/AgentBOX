import { useCallback, useEffect, useState } from "react";
import { Mail, Plus } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { api, googleAuthStartUrl } from "@/lib/api";
import type { GoogleAccount } from "@/lib/api";
import { usePageHeader } from "@/contexts/usePageHeader";
import { useAccountView } from "@/contexts/useAccountView";

/**
 * Google accounts — connect one or more Google accounts so Top of Mind and On
 * Your Calendar can read Gmail and Google Calendar. The OAuth flow is a
 * full-page browser redirect (``/api/google/auth/start``); Google sends the
 * browser back to ``/settings/google?google=…&detail=…``, which this page reads
 * once and then strips from the URL. The connect/remove endpoints live on the
 * box (``/api/google/accounts``); a Google Cloud OAuth client must be installed
 * for connecting to work (``client_configured``).
 */

type Banner = { kind: "success" | "error"; text: string };

const ERROR_DETAIL: Record<string, string> = {
  no_client: "No OAuth client is set up on the box.",
  bad_state: "Authorization expired or was tampered with — try again.",
  exchange_failed: "Couldn't complete authorization with Google.",
  start_failed: "Couldn't start authorization.",
  access_denied: "You declined the Google permission.",
};

/** Read the ``google``/``detail`` query params into a banner, then strip them
 * from the URL so a refresh doesn't re-show the message. */
function readBannerFromUrl(): Banner | null {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("google");
  const detail = params.get("detail");
  if (!status) return null;

  let banner: Banner | null = null;
  if (status === "connected") {
    banner = {
      kind: "success",
      text: detail ? `Connected ${detail}` : "Google account connected.",
    };
  } else if (status === "error") {
    banner = {
      kind: "error",
      text: (detail && ERROR_DETAIL[detail]) || detail || "Authorization failed.",
    };
  }

  // Strip the query params so a refresh doesn't re-show the banner.
  params.delete("google");
  params.delete("detail");
  const qs = params.toString();
  const url = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
  window.history.replaceState(null, "", url);

  return banner;
}

/** Short, human-readable connected date (falls back to the raw string). */
function formatConnectedAt(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function SettingsGooglePage() {
  const { setTitle } = usePageHeader();
  const { refresh: refreshGlobalAccounts } = useAccountView();

  useEffect(() => {
    setTitle("Google accounts");
  }, [setTitle]);

  const [clientConfigured, setClientConfigured] = useState(true);
  const [accounts, setAccounts] = useState<GoogleAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  // Read the OAuth-callback banner once on mount (and strip the query params).
  useEffect(() => {
    setBanner(readBannerFromUrl());
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listGoogleAccounts();
      setClientConfigured(res.client_configured);
      setAccounts(res.accounts);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(() => {
    // Full-page navigation to Google — NOT a fetch.
    window.location.assign(googleAuthStartUrl());
  }, []);

  const remove = useCallback(
    async (email: string) => {
      if (!window.confirm(`Remove ${email}? Hermes will lose access to this account.`))
        return;
      setRemoving(email);
      try {
        await api.removeGoogleAccount(email);
        await refresh();
        refreshGlobalAccounts();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to remove account");
      } finally {
        setRemoving(null);
      }
    },
    [refresh, refreshGlobalAccounts],
  );

  return (
    <div className="mx-auto w-full max-w-3xl">
      <CardDescription className="mb-4">
        Connect one or more Google accounts so your daily brief can read Gmail
        and Google Calendar. You can add several accounts.
      </CardDescription>

      {banner && (
        <div
          className={`mb-4 rounded border px-3 py-2 text-sm ${
            banner.kind === "success"
              ? "border-border bg-muted/20 text-text-secondary"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}
        >
          {banner.text}
        </div>
      )}

      {error && (
        <div className="mb-4 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Spinner className="text-2xl text-primary" />
        </div>
      ) : !clientConfigured ? (
        <Card className="border-dashed">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-text-secondary" />
              <CardTitle>Google isn't set up on this box yet</CardTitle>
            </div>
            <CardDescription>
              No Google Cloud OAuth client is installed, so accounts can't be
              connected yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-4">
            <p className="text-sm text-text-secondary">
              The operator needs to add a Google Cloud OAuth client to the box
              before any account can be connected here. Once that's installed,
              the Connect button below becomes available.
            </p>
            <Button disabled title="No OAuth client installed on the box">
              Connect Google account
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Connect an account</CardTitle>
              <CardDescription>
                Authorize Hermes to read your Gmail and Google Calendar.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-start gap-2">
              <Button onClick={connect} prefix={<Plus className="h-3.5 w-3.5" />}>
                Connect Google account
              </Button>
              <p className="text-xs text-text-tertiary">
                Click again to add another account.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Connected accounts</CardTitle>
              <CardDescription>
                {accounts.length} connected.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {accounts.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  No Google accounts connected yet.
                </p>
              ) : (
                accounts.map((acct) => {
                  const connectedAt = formatConnectedAt(acct.connected_at);
                  return (
                    <div
                      key={acct.email}
                      className="flex items-center gap-3 rounded border border-border px-3 py-2"
                    >
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-bold">
                            {acct.email}
                          </span>
                          {acct.primary && (
                            <Badge tone="secondary">primary</Badge>
                          )}
                        </div>
                        <span className="text-xs text-text-tertiary">
                          {acct.scopes.length} scope
                          {acct.scopes.length === 1 ? "" : "s"}
                          {connectedAt ? ` · connected ${connectedAt}` : ""}
                        </span>
                      </div>
                      <Button
                        outlined
                        destructive
                        size="sm"
                        disabled={removing === acct.email}
                        prefix={removing === acct.email ? <Spinner /> : undefined}
                        onClick={() => void remove(acct.email)}
                      >
                        Remove
                      </Button>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
