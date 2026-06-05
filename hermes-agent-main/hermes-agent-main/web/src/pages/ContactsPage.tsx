import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { Contact as ContactIcon, Pencil, Trash2, X } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { useConfirmDelete } from "@nous-research/ui/hooks/use-confirm-delete";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { useModalBehavior } from "@/hooks/useModalBehavior";
import { usePageHeader } from "@/contexts/usePageHeader";
import { cn, themedBody } from "@/lib/utils";
import { type Contact, type ContactInput, crmApi, type Social } from "@/lib/crm";

interface FormState {
  name: string;
  company: string;
  phones: string;
  emails: string;
  socials: string;
  tags: string;
  notes: string;
}

const EMPTY: FormState = {
  name: "",
  company: "",
  phones: "",
  emails: "",
  socials: "",
  tags: "",
  notes: "",
};

const toList = (s: string): string[] =>
  s.split(",").map((x) => x.trim()).filter(Boolean);
const fromList = (a: string[]): string => a.join(", ");

const toSocials = (s: string): Social[] =>
  s
    .split(",")
    .map((part) => {
      const [platform, ...rest] = part.split(":");
      return { platform: platform.trim(), handle: rest.join(":").trim() };
    })
    .filter((x) => x.platform || x.handle);
const fromSocials = (a: Social[]): string =>
  a.map((x) => `${x.platform}:${x.handle}`).join(", ");

function formToInput(f: FormState): ContactInput {
  return {
    name: f.name.trim(),
    company: f.company.trim(),
    phones: toList(f.phones),
    emails: toList(f.emails),
    socials: toSocials(f.socials),
    tags: toList(f.tags),
    notes: f.notes,
  };
}

export default function ContactsPage() {
  const { setTitle, setEnd } = usePageHeader();
  const { toast, showToast } = useToast();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const closeModal = useCallback(() => {
    setModalOpen(false);
    setEditingId(null);
  }, []);
  const modalRef = useModalBehavior({ open: modalOpen, onClose: closeModal });

  useEffect(() => setTitle("Contacts"), [setTitle]);

  const load = useCallback(() => {
    setLoading(true);
    crmApi
      .listContacts()
      .then(setContacts)
      .catch((e) => showToast(`Failed to load: ${e}`, "error"))
      .finally(() => setLoading(false));
  }, [showToast]);

  useEffect(() => load(), [load]);

  const openCreate = useCallback(() => {
    setEditingId(null);
    setForm(EMPTY);
    setModalOpen(true);
  }, []);

  const openEdit = useCallback((c: Contact) => {
    setEditingId(c.id);
    setForm({
      name: c.name,
      company: c.company,
      phones: fromList(c.phones),
      emails: fromList(c.emails),
      socials: fromSocials(c.socials),
      tags: fromList(c.tags),
      notes: c.notes,
    });
    setModalOpen(true);
  }, []);

  useLayoutEffect(() => {
    setEnd(
      <Button size="sm" className="uppercase" onClick={openCreate}>
        Add Contact
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
      const input = formToInput(form);
      if (editingId != null) {
        await crmApi.updateContact(editingId, input);
        showToast("Saved ✓", "success");
      } else {
        await crmApi.createContact(input);
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
        await crmApi.deleteContact(Number(id));
        showToast("Deleted ✓", "success");
        load();
      },
      [load, showToast],
    ),
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner className="text-2xl text-primary" />
      </div>
    );
  }

  const pending = del.pendingId ? contacts.find((c) => String(c.id) === del.pendingId) : null;
  const field = (id: keyof FormState, label: string, placeholder = "") => (
    <div className="grid gap-2">
      <Label htmlFor={`ct-${id}`}>{label}</Label>
      <Input
        id={`ct-${id}`}
        placeholder={placeholder}
        value={form[id]}
        onChange={(e) => setForm({ ...form, [id]: e.target.value })}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <Toast toast={toast} />
      <DeleteConfirmDialog
        open={del.isOpen}
        onCancel={del.cancel}
        onConfirm={del.confirm}
        title="Delete contact"
        description={pending ? `Delete "${pending.name}"?` : "Delete this contact?"}
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
                {editingId != null ? "Edit contact" : "Add contact"}
              </h2>
            </header>
            <div className="p-5 grid gap-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {field("name", "Name")}
                {field("company", "Company")}
                {field("phones", "Phones", "comma-separated")}
                {field("emails", "Emails", "comma-separated")}
                {field("socials", "Socials", "platform:handle, …")}
                {field("tags", "Tags", "comma-separated")}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ct-notes">Notes</Label>
                <textarea
                  id="ct-notes"
                  className="flex min-h-[60px] w-full border border-border bg-background/40 px-3 py-2 text-sm rounded-[var(--radius-md)] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
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
        <ContactIcon className="h-4 w-4" />
        <span className="text-sm">{contacts.length} contact{contacts.length === 1 ? "" : "s"}</span>
      </div>

      {contacts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-sm text-muted-foreground">No contacts yet.</p>
            <Button size="sm" className="uppercase" onClick={openCreate}>Add Contact</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {contacts.map((c) => (
            <Card key={c.id}>
              <CardContent className="flex items-start gap-4 py-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-sm truncate">{c.name}</span>
                    {c.company && <Badge tone="outline">{c.company}</Badge>}
                    {c.source === "google" && <Badge tone="secondary">google</Badge>}
                    {c.tags.map((t) => (
                      <Badge key={t} tone="outline">{t}</Badge>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {c.emails.map((e) => <span key={e}>{e}</span>)}
                    {c.phones.map((p) => <span key={p}>{p}</span>)}
                    {c.socials.map((s) => <span key={`${s.platform}:${s.handle}`}>{s.platform}: {s.handle}</span>)}
                  </div>
                  {c.notes && <p className="text-xs text-muted-foreground mt-1 truncate">{c.notes}</p>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button ghost size="icon" title="Edit" aria-label="Edit" onClick={() => openEdit(c)}>
                    <Pencil />
                  </Button>
                  <Button ghost destructive size="icon" title="Delete" aria-label="Delete"
                    onClick={() => del.requestDelete(String(c.id))}>
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
