import { useEffect } from "react";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { OAuthProvidersCard } from "@/components/OAuthProvidersCard";
import { usePageHeader } from "@/contexts/usePageHeader";

/**
 * Model Provider Connections — sign in to model providers (OpenAI/ChatGPT login,
 * Anthropic, Nous, Qwen, MiniMax, …) from the dashboard via the in-browser OAuth
 * flow, instead of running `hermes auth add <provider>` on the box. Wraps the
 * shared OAuthProvidersCard (also embedded on the Keys page) so connecting and
 * disconnecting providers lives in its own discoverable section.
 */
export default function ConnectionsPage() {
  const { setTitle } = usePageHeader();
  const { toast, showToast } = useToast();

  useEffect(() => {
    setTitle("Model Provider Connections");
  }, [setTitle]);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <OAuthProvidersCard
        onError={(msg) => showToast(msg, "error")}
        onSuccess={(msg) => showToast(msg, "success")}
      />
      <Toast toast={toast} />
    </div>
  );
}
