import { getPool } from '@/lib/db';

// AgentBOX CRM data layer (migration 047). Raw pg via getPool() — these tables
// are not in the Kysely codegen schema, and CRM is company-wide (not
// account-scoped). Powers the Team + Contacts tabs and the Scheduled Actions
// Department/Employee assignment.

export type TeamKind = 'human' | 'agent';

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

// ── Departments ──────────────────────────────────────────────────────────

export async function listDepartments(): Promise<Department[]> {
  const { rows } = await getPool().query<Department>(
    'SELECT * FROM mailbox.departments ORDER BY name ASC',
  );
  return rows;
}

export async function createDepartment(
  name: string,
  businessId?: number | null,
): Promise<Department> {
  const { rows } = await getPool().query<Department>(
    'INSERT INTO mailbox.departments (name, business_id) VALUES ($1, $2) RETURNING *',
    [name, businessId ?? null],
  );
  return rows[0];
}

export async function updateDepartment(
  id: number,
  patch: { name?: string; business_id?: number | null },
): Promise<Department | null> {
  const cols: string[] = [];
  const vals: unknown[] = [id];
  const add = (col: string, val: unknown) => {
    vals.push(val);
    cols.push(`${col} = $${vals.length}`);
  };
  if (patch.name !== undefined) add('name', patch.name);
  if (patch.business_id !== undefined) add('business_id', patch.business_id);
  if (cols.length === 0) {
    const { rows } = await getPool().query<Department>(
      'SELECT * FROM mailbox.departments WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }
  cols.push('updated_at = NOW()');
  const { rows } = await getPool().query<Department>(
    `UPDATE mailbox.departments SET ${cols.join(', ')} WHERE id = $1 RETURNING *`,
    vals,
  );
  return rows[0] ?? null;
}

export async function deleteDepartment(id: number): Promise<boolean> {
  const res = await getPool().query('DELETE FROM mailbox.departments WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
}

// ── Businesses ─────────────────────────────────────────────────────────────

export async function listBusinesses(): Promise<Business[]> {
  const { rows } = await getPool().query<Business>(
    'SELECT * FROM mailbox.businesses ORDER BY name ASC',
  );
  return rows;
}

export async function createBusiness(name: string, description = ''): Promise<Business> {
  const { rows } = await getPool().query<Business>(
    'INSERT INTO mailbox.businesses (name, description) VALUES ($1, $2) RETURNING *',
    [name, description],
  );
  return rows[0];
}

export async function updateBusiness(
  id: number,
  patch: { name?: string; description?: string },
): Promise<Business | null> {
  const cols: string[] = [];
  const vals: unknown[] = [id];
  const add = (col: string, val: unknown) => {
    vals.push(val);
    cols.push(`${col} = $${vals.length}`);
  };
  if (patch.name !== undefined) add('name', patch.name);
  if (patch.description !== undefined) add('description', patch.description);
  if (cols.length === 0) {
    const { rows } = await getPool().query<Business>(
      'SELECT * FROM mailbox.businesses WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }
  cols.push('updated_at = NOW()');
  const { rows } = await getPool().query<Business>(
    `UPDATE mailbox.businesses SET ${cols.join(', ')} WHERE id = $1 RETURNING *`,
    vals,
  );
  return rows[0] ?? null;
}

// Departments reference businesses ON DELETE SET NULL, so removing a business
// leaves its departments intact (unassigned), not orphaned/deleted.
export async function deleteBusiness(id: number): Promise<boolean> {
  const res = await getPool().query('DELETE FROM mailbox.businesses WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
}

// ── Team ─────────────────────────────────────────────────────────────────

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

export async function listTeam(): Promise<TeamMember[]> {
  const { rows } = await getPool().query<TeamMember>(
    'SELECT * FROM mailbox.team_members ORDER BY name ASC',
  );
  return rows;
}

export async function createTeamMember(input: TeamInput): Promise<TeamMember> {
  const { rows } = await getPool().query<TeamMember>(
    `INSERT INTO mailbox.team_members (name, kind, title, department_id, reports_to, email, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      input.name,
      input.kind ?? 'human',
      input.title ?? '',
      input.department_id ?? null,
      input.reports_to ?? null,
      input.email ?? '',
      input.status ?? 'active',
      input.notes ?? '',
    ],
  );
  return rows[0];
}

export async function updateTeamMember(
  id: number,
  patch: Partial<TeamInput>,
): Promise<TeamMember | null> {
  const cols: string[] = [];
  const vals: unknown[] = [id];
  const add = (col: string, val: unknown) => {
    vals.push(val);
    cols.push(`${col} = $${vals.length}`);
  };
  if (patch.name !== undefined) add('name', patch.name);
  if (patch.kind !== undefined) add('kind', patch.kind);
  if (patch.title !== undefined) add('title', patch.title);
  if (patch.department_id !== undefined) add('department_id', patch.department_id);
  if (patch.reports_to !== undefined) add('reports_to', patch.reports_to);
  if (patch.email !== undefined) add('email', patch.email);
  if (patch.status !== undefined) add('status', patch.status);
  if (patch.notes !== undefined) add('notes', patch.notes);

  if (cols.length === 0) {
    const { rows } = await getPool().query<TeamMember>(
      'SELECT * FROM mailbox.team_members WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }
  cols.push('updated_at = NOW()');
  const { rows } = await getPool().query<TeamMember>(
    `UPDATE mailbox.team_members SET ${cols.join(', ')} WHERE id = $1 RETURNING *`,
    vals,
  );
  return rows[0] ?? null;
}

export async function deleteTeamMember(id: number): Promise<boolean> {
  const res = await getPool().query('DELETE FROM mailbox.team_members WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
}

// ── Contacts (CRM) ─────────────────────────────────────────────────────────

export type ContactInput = {
  name: string;
  company?: string;
  phones?: string[];
  emails?: string[];
  socials?: Social[];
  tags?: string[];
  notes?: string;
  source?: string;
  external_id?: string | null;
};

export async function listContacts(): Promise<Contact[]> {
  const { rows } = await getPool().query<Contact>(
    'SELECT * FROM mailbox.crm_contacts ORDER BY name ASC',
  );
  return rows;
}

export async function createContact(input: ContactInput): Promise<Contact> {
  const { rows } = await getPool().query<Contact>(
    `INSERT INTO mailbox.crm_contacts
       (name, company, phones, emails, socials, tags, notes, source, external_id)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9)
     RETURNING *`,
    [
      input.name,
      input.company ?? '',
      JSON.stringify(input.phones ?? []),
      JSON.stringify(input.emails ?? []),
      JSON.stringify(input.socials ?? []),
      JSON.stringify(input.tags ?? []),
      input.notes ?? '',
      input.source ?? 'manual',
      input.external_id ?? null,
    ],
  );
  return rows[0];
}

export async function updateContact(
  id: number,
  patch: Partial<ContactInput>,
): Promise<Contact | null> {
  const cols: string[] = [];
  const vals: unknown[] = [id];
  const add = (col: string, val: unknown, cast = '') => {
    vals.push(val);
    cols.push(`${col} = $${vals.length}${cast}`);
  };
  if (patch.name !== undefined) add('name', patch.name);
  if (patch.company !== undefined) add('company', patch.company);
  if (patch.phones !== undefined) add('phones', JSON.stringify(patch.phones), '::jsonb');
  if (patch.emails !== undefined) add('emails', JSON.stringify(patch.emails), '::jsonb');
  if (patch.socials !== undefined) add('socials', JSON.stringify(patch.socials), '::jsonb');
  if (patch.tags !== undefined) add('tags', JSON.stringify(patch.tags), '::jsonb');
  if (patch.notes !== undefined) add('notes', patch.notes);

  if (cols.length === 0) {
    const { rows } = await getPool().query<Contact>(
      'SELECT * FROM mailbox.crm_contacts WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }
  cols.push('updated_at = NOW()');
  const { rows } = await getPool().query<Contact>(
    `UPDATE mailbox.crm_contacts SET ${cols.join(', ')} WHERE id = $1 RETURNING *`,
    vals,
  );
  return rows[0] ?? null;
}

export async function deleteContact(id: number): Promise<boolean> {
  const res = await getPool().query('DELETE FROM mailbox.crm_contacts WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
}
