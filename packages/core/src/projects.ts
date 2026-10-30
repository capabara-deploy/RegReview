import { getCustomerDb, type Db } from "./db/index.js";

/**
 * Projects: a device and its documents (see the projects block in
 * customerSchema.sql). The project scopes the document list, the change ledger
 * and the map; it does not scope procedures, which are company-wide.
 */

/** Where anything created before projects existed lives, and the default for callers that don't say. */
export const DEFAULT_PROJECT_ID = "northlake-vp400";

export interface Project {
  projectId: string;
  name: string;
  createdAt: string;
  /** Documents in the project. */
  records: number;
}

export async function listProjects(db: Db = getCustomerDb()): Promise<Project[]> {
  const rows = await db
    .prepare(
      `SELECT p.project_id, p.name, p.created_at, COUNT(r.record_id) AS records
         FROM projects p LEFT JOIN records r ON r.project_id = p.project_id
        GROUP BY p.project_id, p.name, p.created_at
        ORDER BY p.created_at`,
    )
    .all<{ project_id: string; name: string; created_at: string; records: number }>();
  return rows.map((r) => ({ projectId: r.project_id, name: r.name, createdAt: r.created_at, records: r.records }));
}

export async function projectExists(projectId: string, db: Db = getCustomerDb()): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 FROM projects WHERE project_id = ?`).get(projectId));
}

/**
 * Create a project. Its id is a slug of the name, so it reads well in a URL or
 * a log line; a clash gets a numeric suffix rather than an error, since two
 * projects may reasonably share a name.
 */
export async function createProject(name: string, db: Db = getCustomerDb()): Promise<Project> {
  const clean = name.trim();
  if (!clean) throw new Error("a project needs a name");
  const base =
    clean
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project";
  let id = base;
  for (let n = 2; await projectExists(id, db); n++) id = `${base}-${n}`;
  const createdAt = new Date().toISOString();
  await db.prepare(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(id, clean, createdAt);
  return { projectId: id, name: clean, createdAt, records: 0 };
}
