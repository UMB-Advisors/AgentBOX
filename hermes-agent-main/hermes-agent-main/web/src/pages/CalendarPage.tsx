import { useEffect } from "react";
import { CalendarDays } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { usePageHeader } from "@/contexts/usePageHeader";

/**
 * Calendar — navigable placeholder (Phase 1). A real data source is wired in a
 * later phase (see HermesBOX/docs/dashboard-simplification-prd).
 */
export default function CalendarPage() {
  const { setTitle } = usePageHeader();
  useEffect(() => {
    setTitle("Calendar");
  }, [setTitle]);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-text-secondary" />
            <CardTitle>Calendar</CardTitle>
          </div>
          <CardDescription>Schedule and upcoming events.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-text-secondary">
            Calendar view coming soon. This tab is a placeholder until its data
            source is connected.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
