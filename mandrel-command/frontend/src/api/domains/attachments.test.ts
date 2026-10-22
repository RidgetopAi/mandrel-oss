/**
 * attachments domain (lane B's contract) — exercised against a mocked
 * TRANSPORT (`http.*`), never the method under test, so a wrong path, a lost multipart
 * field or a missing un-nest is a red.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { attachmentsApi, ATTACHMENTS_BULK_MAX_IDS } from './attachments';
import { http } from '../request';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('attachmentsApi.list', () => {
  it('GETs /tasks/:id/attachments and un-nests data.attachments', async () => {
    const spy = vi.spyOn(http, 'get').mockResolvedValue({
      success: true,
      data: { attachments: [{ id: 'a1', kind: 'before' }] },
    } as never);
    const rows = await attachmentsApi.list('t-1');
    expect(spy.mock.calls[0][0]).toBe('/tasks/t-1/attachments');
    expect(rows).toEqual([{ id: 'a1', kind: 'before' }]);
  });
  it('an empty payload is an honest []', async () => {
    vi.spyOn(http, 'get').mockResolvedValue({ success: true, data: {} } as never);
    expect(await attachmentsApi.list('t-1')).toEqual([]);
  });
});

describe('attachmentsApi.upload', () => {
  it('POSTs multipart with `file` + `kind`, letting the browser set the boundary', async () => {
    const spy = vi.spyOn(http, 'post').mockResolvedValue({
      success: true,
      data: { attachment: { id: 'a1', kind: 'before' } },
    } as never);
    const file = new File([new Uint8Array(3)], 'shot.jpg', { type: 'image/jpeg' });
    const out = await attachmentsApi.upload('t-1', file, 'before');
    expect(spy.mock.calls[0][0]).toBe('/tasks/t-1/attachments');
    const form = spy.mock.calls[0][1] as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.get('file') as File).name).toBe('shot.jpg');
    expect(form.get('kind')).toBe('before');
    const cfg = spy.mock.calls[0][2] as { headers: Record<string, unknown> };
    expect(cfg.headers['Content-Type']).toBeUndefined();
    expect('Content-Type' in cfg.headers).toBe(true);
    expect(out.id).toBe('a1');
  });
  it('accepts the bare 201 object too (lane B documents the object, not an envelope)', async () => {
    vi.spyOn(http, 'post').mockResolvedValue({ id: 'a2', kind: 'evidence' } as never);
    const out = await attachmentsApi.upload('t-1', new Blob([new Uint8Array(1)]));
    expect(out.id).toBe('a2');
  });
  it('throws when no attachment comes back (no phantom success)', async () => {
    vi.spyOn(http, 'post').mockResolvedValue({ success: true, data: {} } as never);
    await expect(attachmentsApi.upload('t-1', new Blob([new Uint8Array(1)]))).rejects.toThrow('Attachment payload missing');
  });
});

describe('attachmentsApi.blob / remove', () => {
  it('blob GETs /attachments/:id with responseType blob (authed via the shared instance)', async () => {
    const spy = vi.spyOn(http, 'get').mockResolvedValue(new Blob([new Uint8Array(2)]) as never);
    const b = await attachmentsApi.blob('a1');
    expect(spy.mock.calls[0][0]).toBe('/attachments/a1');
    expect((spy.mock.calls[0][1] as { responseType: string }).responseType).toBe('blob');
    expect(b).toBeInstanceOf(Blob);
  });
  it('remove DELETEs /attachments/:id', async () => {
    const spy = vi.spyOn(http, 'del').mockResolvedValue(undefined as never);
    await attachmentsApi.remove('a1');
    expect(spy.mock.calls[0][0]).toBe('/attachments/a1');
  });
});

describe('attachmentsApi.listForTasks — the bulk board read (lane B)', () => {
  it('GETs /attachments with a comma-joined taskIds param and un-nests data.attachments', async () => {
    const spy = vi.spyOn(http, 'get').mockResolvedValue({
      success: true,
      data: { attachments: [{ id: 'a1', taskId: 't-1', kind: 'before' }] },
    } as never);
    const rows = await attachmentsApi.listForTasks(['t-1', 't-2']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('/attachments');
    expect((spy.mock.calls[0][1] as { params: Record<string, string> }).params).toEqual({ taskIds: 't-1,t-2' });
    expect(rows).toEqual([{ id: 'a1', taskId: 't-1', kind: 'before' }]);
  });
  it('chunks at the server cap and concatenates, in order', async () => {
    const spy = vi.spyOn(http, 'get').mockImplementation(async (_u, cfg) => {
      const ids = ((cfg as { params: { taskIds: string } }).params.taskIds).split(',');
      return { success: true, data: { attachments: ids.map((id) => ({ id: `a-${id}`, taskId: id, kind: 'before' })) } } as never;
    });
    const ids = Array.from({ length: ATTACHMENTS_BULK_MAX_IDS + 1 }, (_, i) => `t-${i}`);
    const rows = await attachmentsApi.listForTasks(ids);
    expect(spy).toHaveBeenCalledTimes(2);
    expect((spy.mock.calls[0][1] as { params: { taskIds: string } }).params.taskIds.split(',')).toHaveLength(ATTACHMENTS_BULK_MAX_IDS);
    expect((spy.mock.calls[1][1] as { params: { taskIds: string } }).params.taskIds).toBe(`t-${ATTACHMENTS_BULK_MAX_IDS}`);
    expect(rows).toHaveLength(ATTACHMENTS_BULK_MAX_IDS + 1);
    expect(rows[0].taskId).toBe('t-0');
  });
  it('no ids → no request, honest []', async () => {
    const spy = vi.spyOn(http, 'get');
    expect(await attachmentsApi.listForTasks([])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
  it('an omitted (out-of-scope) task is simply absent, never a throw', async () => {
    vi.spyOn(http, 'get').mockResolvedValue({ success: true, data: { attachments: [] } } as never);
    expect(await attachmentsApi.listForTasks(['not-mine'])).toEqual([]);
  });
});
