// Removing a workspace: the main (first registered) workspace can never be removed; any other is hidden, and its data is kept.
import { describe, expect, it } from 'vitest';
import { createAutopilotAdapter } from '../src/server/adapters/autopilot';
import { demoDocs } from '../src/server/demo/fixtures';
import { memoryGrist } from '../src/server/grist';

const make = (allowCreate = true) => {
  const { docs } = demoDocs(Date.now());
  const mem = memoryGrist(docs);
  const adapter = createAutopilotAdapter({ gristBaseUrl: 'http://memory', gristApiKey: '', registryDocId: 'REGISTRY', timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR', fetchImpl: mem, cacheMs: 1000, allowCreate });
  return { adapter, docs };
};

describe('deleting a workspace', () => {
  it('marks only the first registered workspace as the protected main one', async () => {
    const { adapter } = make();
    const list = await adapter.listWorkspaces();
    expect(list.length).toBeGreaterThan(1);
    expect(list.filter((w) => w.protected).length).toBe(1);
    expect(list[0]!.protected).toBe(true);
  });

  it('refuses to delete the main workspace', async () => {
    const { adapter } = make();
    const main = (await adapter.listWorkspaces()).find((w) => w.protected)!;
    await expect(adapter.deleteWorkspace!(main.id)).rejects.toMatchObject({ code: 'protected' });
    expect((await adapter.listWorkspaces()).some((w) => w.id === main.id)).toBe(true);
  });

  it('hides any other workspace but keeps its data', async () => {
    const { adapter, docs } = make();
    const other = (await adapter.listWorkspaces()).find((w) => !w.protected)!;
    const docId = String(docs.REGISTRY!.Clinics!.find((r) => r.fields.Clinic_Slug === other.id)!.fields.Grist_Doc_ID);
    await adapter.deleteWorkspace!(other.id);
    expect((await adapter.listWorkspaces()).some((w) => w.id === other.id)).toBe(false);
    expect(await adapter.workspace(other.id)).toBeNull();
    expect(docs[docId]).toBeTruthy();                                      // the document itself is untouched
    await expect(adapter.deleteWorkspace!(other.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('is not offered when the backend cannot add or remove workspaces (demo mode)', () => {
    expect(make(false).adapter.deleteWorkspace).toBeUndefined();
  });
});
