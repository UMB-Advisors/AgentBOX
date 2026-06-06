import { useCallback, useEffect, useState } from "react";
import { ShoppingBag, Plus } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { api, shopifyAuthStartUrl } from "@/lib/api";
import type { ShopifyAccount } from "@/lib/api";
import { usePageHeader } from "@/contexts/usePageHeader";

/**
 * Shopify stores — connect one or more Shopify stores so the shopify toolset
 * can read and write blog content. The OAuth flow is a full-page browser
 * redirect (``/api/shopify/auth/start?shop=…``); Shopify sends the browser
 * back to ``/settings/shopify?shopify=…&detail=…``, which this page reads once
 * and then strips from the URL. The connect/remove endpoints live on the box
 * (``/api/shopify/accounts``); a Shopify OAuth app (SHOPIFY_APP_CLIENT_ID /
 * SHOPIFY_APP_CLIENT_SECRET) must be installed for connecting to work
 * (``client_configured``).
 */

type Banner = { kind: "success" | "error"; text: string };

const ERROR_DETAIL: Record<string, string> = {
  no_client: "No Shopify OAuth app is set up on the box.",
  bad_shop: "That doesn't look like a valid *.myshopify.com store domain.",
  bad_state: "Authorization expired or was tampered with — try again.",
  exchange_failed: "Couldn't complete authorization with Shopify.",
  start_failed: "Couldn't start authorization.",
  access_denied: "You declined the Shopify permission.",
};

/** A syntactically valid ``*.myshopify.com`` store domain. Mirrors the
 * server-side gate so we don't even start a flow for an obviously bad value. */
const SHOP_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

/** Read the ``shopify``/``detail`` query params into a banner, then strip them
 * from the URL so a refresh doesn't re-show the message. */
function readBannerFromUrl(): Banner | null {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("shopify");
  const detail = params.get("detail");
  if (!status) return null;

  let banner: Banner | null = null;
  if (status === "connected") {
    banner = {
      kind: "success",
      text: detail ? `Connected ${detail}` : "Shopify store connected.",
    };
  } else if (status === "error") {
    banner = {
      kind: "error",
      text: (detail && ERROR_DETAIL[detail]) || detail || "Authorization failed.",
    };
  }

  // Strip the query params so a refresh doesn't re-show the banner.
  params.delete("shopify");
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

export default function SettingsShopifyPage() {
  const { setTitle } = usePageHeader();

  useEffect(() => {
    setTitle("Shopify stores");
  }, [setTitle]);

  const [clientConfigured, setClientConfigured] = useState(true);
  const [accounts, setAccounts] = useState<ShopifyAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [shopInput, setShopInput] = useState("");

  // Read the OAuth-callback banner once on mount (and strip the query params).
  useEffect(() => {
    setBanner(readBannerFromUrl());
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listShopifyAccounts();
      setClientConfigured(res.client_configured);
      setAccounts(res.accounts);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load stores");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const normalizedShop = shopInput.trim().toLowerCase();
  const shopValid = SHOP_RE.test(normalizedShop);

  const connect = useCallback(() => {
    if (!shopValid) return;
    // Full-page navigation to Shopify — NOT a fetch.
    window.location.assign(shopifyAuthStartUrl(normalizedShop));
  }, [normalizedShop, shopValid]);

  const remove = useCallback(
    async (shop: string) => {
      if (
        !window.confirm(
          `Remove ${shop}? Hermes will lose access to this store.`,
        )
      )
        return;
      setRemoving(shop);
      try {
        await api.removeShopifyAccount(shop);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to remove store");
      } finally {
        setRemoving(null);
      }
    },
    [refresh],
  );

  return (
    <div className="mx-auto w-full max-w-3xl">
      <CardDescription className="mb-4">
        Connect one or more Shopify stores so Hermes can read and write blog
        content on the storefront. You can add several stores.
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
              <ShoppingBag className="h-4 w-4 text-text-secondary" />
              <CardTitle>Shopify isn't set up on this box yet</CardTitle>
            </div>
            <CardDescription>
              No Shopify OAuth app is installed, so stores can't be connected
              yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-4">
            <p className="text-sm text-text-secondary">
              The operator needs to set SHOPIFY_APP_CLIENT_ID and
              SHOPIFY_APP_CLIENT_SECRET on the box before any store can be
              connected here. Once those are set, the Connect button below
              becomes available.
            </p>
            <Button disabled title="No Shopify OAuth app installed on the box">
              Connect Shopify store
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Connect a store</CardTitle>
              <CardDescription>
                Enter your store domain, then authorize Hermes to read and write
                blog content.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-start gap-2">
              <input
                type="text"
                value={shopInput}
                onChange={(e) => setShopInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && shopValid) connect();
                }}
                placeholder="your-store.myshopify.com"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                className="w-full max-w-sm rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
              {shopInput.trim() !== "" && !shopValid && (
                <p className="text-xs text-destructive">
                  Enter a valid store domain (e.g. your-store.myshopify.com).
                </p>
              )}
              <Button
                onClick={connect}
                disabled={!shopValid}
                prefix={<Plus className="h-3.5 w-3.5" />}
              >
                Connect Shopify store
              </Button>
              <p className="text-xs text-text-tertiary">
                Enter another domain to add another store.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Connected stores</CardTitle>
              <CardDescription>
                {accounts.length} connected.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {accounts.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  No Shopify stores connected yet.
                </p>
              ) : (
                accounts.map((acct) => {
                  const connectedAt = formatConnectedAt(acct.connected_at);
                  const scopeCount = acct.scope
                    ? acct.scope.split(",").filter(Boolean).length
                    : 0;
                  return (
                    <div
                      key={acct.shop_domain}
                      className="flex items-center gap-3 rounded border border-border px-3 py-2"
                    >
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-bold">
                            {acct.shop_domain}
                          </span>
                        </div>
                        <span className="text-xs text-text-tertiary">
                          {scopeCount} scope
                          {scopeCount === 1 ? "" : "s"}
                          {connectedAt ? ` · connected ${connectedAt}` : ""}
                        </span>
                      </div>
                      <Button
                        outlined
                        destructive
                        size="sm"
                        disabled={removing === acct.shop_domain}
                        prefix={
                          removing === acct.shop_domain ? <Spinner /> : undefined
                        }
                        onClick={() => void remove(acct.shop_domain)}
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
