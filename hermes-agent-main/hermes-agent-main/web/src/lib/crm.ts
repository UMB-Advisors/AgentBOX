// Client for the AgentBOX CRM API. These endpoints live in the Node
// mailbox-dashboard (migration 047) and are reached SAME-ORIGIN through the
// hermes dashboard's reverse proxy: `/dashboard/api/crm/*` →
// mailbox-dashboard:3001. No hermes session token needed (the proxy gates only
// `/api/*`; the mailbox app has no auth on loopback, Caddy gates the funnel).

const CRM_BASE = "/dashboard/api/crm";

export type TeamKind = "human" | "agent";

export interface Business {
  id: number;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface Department {
  id: number;
  name: string;
  business_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface TeamMember {
  id: number;
  name: string;
  kind: TeamKind;
  title: string;
  department_id: number | null;
  reports_to: number | null;
  email: string;
  status: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface Social {
  platform: string;
  handle: string;
}

export interface Contact {
  id: number;
  name: string;
  company: string;
  phones: string[];
  emails: string[];
  socials: Social[];
  tags: string[];
  notes: string;
  source: string;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

async function crm<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CRM_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...init,
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const j = await res.json();
      detail = j?.error ? `${res.status} ${j.error}` : detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`CRM request failed: ${detail}`);
  }
  return (await res.json()) as T;
}

export type TeamInput = {
  name: string;
  kind?: TeamKind;
  title?: string;
  department_id?: number | null;
  reports_to?: number | null;
  email?: string;
  status?: string;
  notes?: string;
};

export type ContactInput = {
  name: string;
  company?: string;
  phones?: string[];
  emails?: string[];
  socials?: Social[];
  tags?: string[];
  notes?: string;
};

export const crmApi = {
  // Businesses
  listBusinesses: () =>
    crm<{ businesses: Business[] }>("/businesses").then((r) => r.businesses),
  createBusiness: (name: string, description = "") =>
    crm<{ business: Business }>("/businesses", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    }).then((r) => r.business),
  updateBusiness: (id: number, patch: { name?: string; description?: string }) =>
    crm<{ business: Business }>(`/businesses/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }).then((r) => r.business),
  deleteBusiness: (id: number) =>
    crm<{ deleted: boolean }>(`/businesses/${id}`, { method: "DELETE" }),

  // Departments
  listDepartments: () =>
    crm<{ departments: Department[] }>("/departments").then((r) => r.departments),
  createDepartment: (name: string, businessId?: number | null) =>
    crm<{ department: Department }>("/departments", {
      method: "POST",
      body: JSON.stringify({ name, business_id: businessId ?? null }),
    }).then((r) => r.department),
  updateDepartment: (id: number, patch: { name?: string; business_id?: number | null }) =>
    crm<{ department: Department }>(`/departments/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }).then((r) => r.department),
  deleteDepartment: (id: number) =>
    crm<{ deleted: boolean }>(`/departments/${id}`, { method: "DELETE" }),

  // Team
  listTeam: () => crm<{ team: TeamMember[] }>("/team").then((r) => r.team),
  createTeamMember: (input: TeamInput) =>
    crm<{ member: TeamMember }>("/team", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.member),
  updateTeamMember: (id: number, patch: Partial<TeamInput>) =>
    crm<{ member: TeamMember }>(`/team/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }).then((r) => r.member),
  deleteTeamMember: (id: number) =>
    crm<{ deleted: boolean }>(`/team/${id}`, { method: "DELETE" }),

  // Contacts
  listContacts: () => crm<{ contacts: Contact[] }>("/contacts").then((r) => r.contacts),
  createContact: (input: ContactInput) =>
    crm<{ contact: Contact }>("/contacts", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.contact),
  updateContact: (id: number, patch: Partial<ContactInput>) =>
    crm<{ contact: Contact }>(`/contacts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }).then((r) => r.contact),
  deleteContact: (id: number) =>
    crm<{ deleted: boolean }>(`/contacts/${id}`, { method: "DELETE" }),
};
