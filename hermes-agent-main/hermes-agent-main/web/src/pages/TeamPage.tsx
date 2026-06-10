import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { Pencil, Trash2, Users, X } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { Select, SelectOption } from "@nous-research/ui/ui/components/select";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { useConfirmDelete } from "@nous-research/ui/hooks/use-confirm-delete";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { useModalBehavior } from "@/hooks/useModalBehavior";
import { usePageHeader } from "@/contexts/usePageHeader";
import { cn, themedBody } from "@/lib/utils";
import {
  crmApi,
  type Department,
  type TeamInput,
  type TeamKind,
  type TeamMember,
} from "@/lib/crm";

const EMPTY: TeamInput = {
  name: "",
  kind: "human",
  title: "",
  department_id: null,
  reports_to: null,
  email: "",
  status: "active",
  notes: "",
};

export default function TeamPage() {
  const { setTitle, setEnd } = usePageHeader();
  const { toast, showToast } = useToast();

  const [team, setTeam] = useState<TeamMember[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<TeamInput>(EMPTY);
  const [saving, setSaving] = useState(false);
  const closeModal = useCallback(() => {
    setModalOpen(false);
    setEditingId(null);
  }, []);
  const modalRef = useModalBehavior({ open: modalOpen, onClose: closeModal });

  useEffect(() => setTitle("Team"), [setTitle]);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([crmApi.listTeam(), crmApi.listDepartments()])
      .then(([t, d]) => {
        setTeam(t);
        setDepartments(d);
      })
      .catch((e) => showToast(`Failed to load: ${e}`, "error"))
      .finally(() => setLoading(false));
  }, [showToast]);

  useEffect(() => load(), [load]);

  const openCreate = useCallback(() => {
    setEditingId(null);
    setForm(EMPTY);
    setModalOpen(true);
  }, []);

  const openEdit = useCallback((m: TeamMember) => {
    setEditingId(m.id);
    setForm({
      name: m.name,
      kind: m.kind,
      title: m.title,
      department_id: m.department_id,
      reports_to: m.reports_to,
      email: m.email,
      status: m.status,
      notes: m.notes,
    });
    setModalOpen(true);
  }, []);

  useLayoutEffect(() => {
    setEnd(
      <Button size="sm" className="uppercase" onClick={openCreate}>
        Add Member
      </Button>,
    );
    return () => setEnd(null);
  }, [setEnd, openCreate]);

  const handleSave = async () => {
    if (!form.name.trim()) {
      showToast("Name required", "error");
      return;
    }
    setSaving(true);
    try {
      if (editingId != null) {
        await crmApi.updateTeamMember(editingId, form);
        showToast("Saved ✓", "success");
      } else {
        await crmApi.createTeamMember(form);
        showToast("Added ✓", "success");
      }
      closeModal();
      load();
    } catch (e) {
      showToast(`Save failed: ${e}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const del = useConfirmDelete({
    onDelete: useCallback(
      async (id: string) => {
        await crmApi.deleteTeamMember(Number(id));
        showToast("Deleted ✓", "success");
        load();
      },
      [load, showToast],
    ),
  });

  const deptName = (id: number | null) =>
    id == null ? "" : (departments.find((d) => d.id === id)?.name ?? "");
  const mgrName = (id: number | null) =>
    id == null ? "" : (team.find((m) => m.id === id)?.name ?? "");

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner className="text-2xl text-primary" />
      </div>
    );
  }

  const pending = del.pendingId ? team.find((m) => String(m.id) === del.pendingId) : null;

  return (
    <div className="flex flex-col gap-6">
      <Toast toast={toast} />
      <DeleteConfirmDialog
        open={del.isOpen}
        onCancel={del.cancel}
        onConfirm={del.confirm}
        title="Remove team member"
        description={pending ? `Remove "${pending.name}"?` : "Remove this member?"}
        loading={del.isDeleting}
      />

      {modalOpen && (
        <div
          ref={modalRef}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-background/85 backdrop-blur-sm p-4"
          onClick={(e) => e.target === e.currentTarget && closeModal()}
          role="dialog"
          aria-modal="true"
        >
          <div className={cn(themedBody, "relative w-full max-w-lg border border-border bg-card shadow-2xl")}>
            <Button
              ghost
              size="icon"
              onClick={closeModal}
              className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <X />
            </Button>
            <header className="p-5 pb-3 border-b border-border">
              <h2 className="text-base font-semibold tracking-tight">
                {editingId != null ? "Edit member" : "Add team member"}
              </h2>
            </header>
            <div className="p-5 grid gap-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="tm-name">Name</Label>
                  <Input id="tm-name" autoFocus value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="tm-kind">Type</Label>
                  <Select id="tm-kind" value={form.kind ?? "human"}
                    onValueChange={(v) => setForm({ ...form, kind: v as TeamKind })}>
                    <SelectOption value="human">Human</SelectOption>
                    <SelectOption value="agent">Agent</SelectOption>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="tm-title">Title / role</Label>
                  <Input id="tm-title" value={form.title ?? ""}
                    onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="tm-dept">Department</Label>
                  <Select id="tm-dept" value={form.department_id == null ? "" : String(form.department_id)}
                    onValueChange={(v) => setForm({ ...form, department_id: v ? Number(v) : null })}>
                    <SelectOption value="">—</SelectOption>
                    {departments.map((d) => (
                      <SelectOption key={d.id} value={String(d.id)}>{d.name}</SelectOption>
                    ))}
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="tm-reports-to">Reports to</Label>
                  <Select id="tm-reports-to" value={form.reports_to == null ? "" : String(form.reports_to)}
                    onValueChange={(v) => setForm({ ...form, reports_to: v ? Number(v) : null })}>
                    <SelectOption value="">—</SelectOption>
                    {team
                      .filter((m) => m.id !== editingId)
                      .map((m) => (
                        <SelectOption key={m.id} value={String(m.id)}>{m.name}</SelectOption>
                      ))}
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="tm-email">Email</Label>
                  <Input id="tm-email" value={form.email ?? ""}
                    onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="tm-status">Status</Label>
                  <Select id="tm-status" value={form.status ?? "active"}
                    onValueChange={(v) => setForm({ ...form, status: v })}>
                    <SelectOption value="active">Active</SelectOption>
                    <SelectOption value="inactive">Inactive</SelectOption>
                  </Select>
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="tm-notes">Notes</Label>
                <textarea id="tm-notes"
                  className="flex min-h-[60px] w-full border border-border bg-background/40 px-3 py-2 text-sm rounded-[var(--radius-md)] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
                  value={form.notes ?? ""}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
              <div className="flex justify-end">
                <Button size="sm" className="uppercase" onClick={handleSave} disabled={saving}
                  prefix={saving ? <Spinner /> : undefined}>
                  {editingId != null ? "Save" : "Add"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 text-muted-foreground">
        <Users className="h-4 w-4" />
        <span className="text-sm">{team.length} member{team.length === 1 ? "" : "s"}</span>
      </div>

      {team.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-sm text-muted-foreground">No team members yet.</p>
            <Button size="sm" className="uppercase" onClick={openCreate}>Add Member</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {team.map((m) => (
            <Card key={m.id}>
              <CardContent className="flex items-start gap-4 py-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-sm truncate">{m.name}</span>
                    <Badge tone={m.kind === "agent" ? "secondary" : "outline"}>{m.kind}</Badge>
                    {m.status === "inactive" && <Badge tone="warning">inactive</Badge>}
                    {deptName(m.department_id) && <Badge tone="outline">{deptName(m.department_id)}</Badge>}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {m.title && <span>{m.title}</span>}
                    {m.email && <span>{m.email}</span>}
                    {mgrName(m.reports_to) && <span>↳ reports to {mgrName(m.reports_to)}</span>}
                  </div>
                  {m.notes && <p className="text-xs text-muted-foreground mt-1 truncate">{m.notes}</p>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button ghost size="icon" title="Edit" aria-label="Edit" onClick={() => openEdit(m)}>
                    <Pencil />
                  </Button>
                  <Button ghost destructive size="icon" title="Delete" aria-label="Delete"
                    onClick={() => del.requestDelete(String(m.id))}>
                    <Trash2 />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
