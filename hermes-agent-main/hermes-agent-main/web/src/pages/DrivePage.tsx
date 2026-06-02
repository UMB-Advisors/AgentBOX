import { useEffect } from "react";
import { HardDrive } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { Button } from "@nous-research/ui/ui/components/button";
import { usePageHeader } from "@/contexts/usePageHeader";

/**
 * Drive — navigable placeholder (Phase 1). The slot where a Google Drive
 * connects; the real OAuth flow + file browser are wired in a later phase
 * (needs a Google OAuth client + Drive API endpoints). Mirrors CalendarPage.
 */
export default function DrivePage() {
  const { setTitle } = usePageHeader();
  useEffect(() => {
    setTitle("Drive");
  }, [setTitle]);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-text-secondary" />
            <CardTitle>Drive</CardTitle>
          </div>
          <CardDescription>Connect a Google Drive to browse files.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-4">
          <p className="text-sm text-text-secondary">
            No Drive connected yet. Connecting a Google Drive will let you browse
            and search files from here. The connection flow is coming soon — this
            tab is the placeholder until it's wired up.
          </p>
          <Button disabled title="Coming soon">
            Connect Google Drive
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
