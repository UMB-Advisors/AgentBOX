import { useCallback, useEffect, useState } from "react";
import { Building2, Plus, Trash2 } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { usePageHeader } from "@/contexts/usePageHeader";
import { type Business, crmApi, type Department } from "@/lib/crm";

export default function BusinessesPage() {
  const { setTitle } = usePageHeader();
  const { toast, showToast } = useToast();

  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);

  const [bizName, setBizName] = useState("");
  const [bizDesc, setBizDesc] = useState("");
  const [deptDrafts, setDeptDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => setTitle("Businesses"), [setTitle]);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([crmApi.listBusinesses(), crmApi.listDepartments()])
      .then(([b, d]) => {
        setBusinesses(b);
        setDepartments(d);
      })
      .catch((e) => showToast(`Failed to load: ${e}`, "error"))
      .finally(() => setLoading(false));
  }, [showToast]);

  useEffect(() => load(), [load]);

  const addBusiness = async () => {
    if (!bizName.trim()) {
      showToast("Business name required", "error");
      return;
    }
    setBusy(true);
    try {
      await crmApi.createBusiness(bizName.trim(), bizDesc.trim());
      setBizName("");
      setBizDesc("");
      showToast("Business added ✓", "success");
      load();
    } catch (e) {
      showToast(`${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const removeBusiness = async (b: Business) => {
    try {
      await crmApi.deleteBusiness(b.id);
      showToast(`Removed "${b.name}" (its departments are kept, unassigned)`, "success");
      load();
    } catch (e) {
      showToast(`${e}`, "error");
    }
  };

  const addDepartment = async (businessId: number) => {
    const name = (deptDrafts[businessId] ?? "").trim();
    if (!name) return;
    try {
      await crmApi.createDepartment(name, businessId);
      setDeptDrafts((d) => ({ ...d, [businessId]: "" }));
      load();
    } catch (e) {
      showToast(`${e}`, "error");
    }
  };

  const removeDepartment = async (d: Department) => {
    try {
      await crmApi.deleteDepartment(d.id);
      load();
    } catch (e) {
      showToast(`${e}`, "error");
    }
  };

  const deptsFor = (businessId: number | null) =>
    departments.filter((d) => d.business_id === businessId);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner className="text-2xl text-primary" />
      </div>
    );
  }

  const unassigned = deptsFor(null);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Toast toast={toast} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4" /> Add a business
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="biz-name">Name</Label>
              <Input id="biz-name" value={bizName} placeholder="e.g. Heron Labs"
                onChange={(e) => setBizName(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="biz-desc">Description</Label>
              <Input id="biz-desc" value={bizDesc} placeholder="optional"
                onChange={(e) => setBizDesc(e.target.value)} />
            </div>
          </div>
          <div className="flex justify-end">
            <Button size="sm" className="uppercase" onClick={addBusiness} disabled={busy}
              prefix={busy ? <Spinner /> : <Plus />}>
              Add Business
            </Button>
          </div>
        </CardContent>
      </Card>

      {businesses.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No businesses yet. Add one above, then create its departments.
          </CardContent>
        </Card>
      ) : (
        businesses.map((b) => (
          <Card key={b.id}>
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <CardTitle className="truncate">{b.name}</CardTitle>
                  {b.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">{b.description}</p>
                  )}
                </div>
                <Button ghost destructive size="icon" title="Remove business" aria-label="Remove business"
                  onClick={() => removeBusiness(b)}>
                  <Trash2 />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {deptsFor(b.id).length === 0 ? (
                  <span className="text-xs text-muted-foreground">No departments yet.</span>
                ) : (
                  deptsFor(b.id).map((d) => (
                    <Badge key={d.id} tone="outline" className="flex items-center gap-1">
                      {d.name}
                      <button type="button" aria-label={`Remove ${d.name}`}
                        className="ml-1 text-muted-foreground hover:text-destructive"
                        onClick={() => removeDepartment(d)}>
                        ×
                      </button>
                    </Badge>
                  ))
                )}
              </div>
              <div className="flex items-end gap-2">
                <div className="grid flex-1 gap-1">
                  <Label htmlFor={`dept-${b.id}`}>Add department</Label>
                  <Input
                    id={`dept-${b.id}`}
                    value={deptDrafts[b.id] ?? ""}
                    placeholder="e.g. Production"
                    onChange={(e) => setDeptDrafts((dd) => ({ ...dd, [b.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addDepartment(b.id);
                    }}
                  />
                </div>
                <Button size="sm" className="uppercase" onClick={() => addDepartment(b.id)} prefix={<Plus />}>
                  Add
                </Button>
              </div>
            </CardContent>
          </Card>
        ))
      )}

      {unassigned.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Unassigned departments</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            {unassigned.map((d) => (
              <Badge key={d.id} tone="outline" className="flex items-center gap-1">
                {d.name}
                <button type="button" aria-label={`Remove ${d.name}`}
                  className="ml-1 text-muted-foreground hover:text-destructive"
                  onClick={() => removeDepartment(d)}>
                  ×
                </button>
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
