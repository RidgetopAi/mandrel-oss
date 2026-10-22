/**
 * AttachmentGallery — Before / Evidence split, the always-rendered
 * empty Evidence section, and the delete confirm. Images are fetched through the authed
 * hook, so `api.attachments.blob` is mocked and the object URL stubbed. an earlier Task added
 * the image's own click-to-open-full-size (previously only the non-image file tile had one).
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api', () => ({
  api: { attachments: { blob: vi.fn() } },
}));

import { api } from '../../api';
import { AttachmentGallery } from './AttachmentGallery';
import type { TaskAttachment } from '../../types/attachment';

const mockApi = api as unknown as { attachments: { blob: ReturnType<typeof vi.fn> } };

const att = (over: Partial<TaskAttachment>): TaskAttachment => ({
  id: 'att-1',
  taskId: 't-1',
  kind: 'before',
  filename: 'before.jpg',
  mime: 'image/jpeg',
  byteSize: 1234,
  createdAt: '2026-09-10T00:00:00.000Z',
  url: '/api/attachments/att-1',
  ...over,
});

let container: HTMLDivElement;
let root: Root;

function mount(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(ui);
  });
}
async function settle() {
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.attachments.blob.mockResolvedValue(new Blob([new Uint8Array(2)], { type: 'image/jpeg' }));
  (globalThis as unknown as { URL: typeof URL }).URL.createObjectURL = vi.fn((b: Blob) => `blob:${b.size}`);
  (globalThis as unknown as { URL: typeof URL }).URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

const section = (kind: string) => container.querySelector(`section[data-kind="${kind}"]`) as HTMLElement;

describe('AttachmentGallery', () => {
  it('renders BOTH sections, evidence quietly empty, before with its images', async () => {
    mount(
      <AttachmentGallery
        attachments={[att({ id: 'a' }), att({ id: 'b', filename: 'two.jpg' })]}
        isLoading={false}
        isError={false}
        error={null}
        onDelete={() => {}}
      />,
    );
    await settle();
    expect(section('before').querySelectorAll('li')).toHaveLength(2);
    expect(section('before').textContent).toContain('2');
    expect(section('evidence')).not.toBeNull();
    expect(section('evidence').textContent).toContain('no evidence yet');
    // The images went through the AUTHED fetch (never a bare URL).
    expect(mockApi.attachments.blob).toHaveBeenCalledWith('a');
    expect(mockApi.attachments.blob).toHaveBeenCalledWith('b');
    const imgs = Array.from(section('before').querySelectorAll('img'));
    expect(imgs).toHaveLength(2);
    expect(imgs.every((i) => i.getAttribute('src')?.startsWith('blob:'))).toBe(true);
    expect(imgs.every((i) => !i.getAttribute('src')?.includes('token'))).toBe(true);
  });

  it('evidence images land in the Evidence section', async () => {
    mount(
      <AttachmentGallery
        attachments={[att({ id: 'e', kind: 'evidence', filename: 'proof.png' })]}
        isLoading={false}
        isError={false}
        error={null}
        onDelete={() => {}}
      />,
    );
    await settle();
    expect(section('evidence').querySelectorAll('li')).toHaveLength(1);
    expect(section('before').textContent).toContain('no photo');
  });

  it('an empty list renders both sections empty (no crash, no fabricated rows)', () => {
    mount(<AttachmentGallery attachments={[]} isLoading={false} isError={false} error={null} onDelete={() => {}} />);
    expect(section('before').querySelectorAll('li')).toHaveLength(0);
    expect(section('evidence').querySelectorAll('li')).toHaveLength(0);
  });

  it('delete is CONFIRMED before onDelete fires, and Keep backs out', async () => {
    const onDelete = vi.fn();
    mount(
      <AttachmentGallery attachments={[att({ id: 'a' })]} isLoading={false} isError={false} error={null} onDelete={onDelete} />,
    );
    await settle();
    const del = container.querySelector('button[aria-label="Delete before.jpg"]') as HTMLButtonElement;
    act(() => del.click());
    expect(onDelete).not.toHaveBeenCalled();
    const buttons = Array.from(container.querySelectorAll('button'));
    const keep = buttons.find((b) => b.textContent === 'Keep') as HTMLButtonElement;
    act(() => keep.click());
    expect(onDelete).not.toHaveBeenCalled();
    act(() => (container.querySelector('button[aria-label="Delete before.jpg"]') as HTMLButtonElement).click());
    const confirm = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Delete' && !b.getAttribute('aria-label')) as HTMLButtonElement;
    act(() => confirm.click());
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0][0].id).toBe('a');
  });

  it('a non-image attachment is a FILE tile (icon + name + size), never an <img>, and opens the AUTHED bytes only on click', async () => {
    mockApi.attachments.blob.mockResolvedValue(new Blob(['hello'], { type: 'text/plain' }));
    const open = vi.fn();
    (window as unknown as { open: unknown }).open = open;
    mount(
      <AttachmentGallery
        attachments={[att({ id: 'n', filename: 'notes.txt', mime: 'text/plain', byteSize: 5 }), att({ id: 'i' })]}
        isLoading={false}
        isError={false}
        error={null}
        onDelete={() => {}}
      />,
    );
    await settle();
    expect(section('before').querySelectorAll('li')).toHaveLength(2);
    // exactly ONE <img> — the image; the text file is not rendered as one
    expect(section('before').querySelectorAll('img')).toHaveLength(1);
    const tile = container.querySelector('button[aria-label="Open notes.txt"]') as HTMLButtonElement;
    expect(tile).not.toBeNull();
    expect(tile.textContent).toContain('notes.txt');
    expect(tile.textContent).toContain('5 B');
    // nothing fetched for the file on mount — only the image preloaded
    expect(mockApi.attachments.blob).toHaveBeenCalledTimes(1);
    expect(mockApi.attachments.blob).toHaveBeenCalledWith('i');
    act(() => tile.click());
    await settle();
    expect(mockApi.attachments.blob).toHaveBeenCalledWith('n');
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0][0])).toMatch(/^blob:/);
    expect(String(open.mock.calls[0][0])).not.toContain('token');
  });

  it('an image opens the full-size AUTHED blob on click (mirrors the file tile), is focusable and named, and never lets that click reach Delete', async () => {
    const open = vi.fn();
    (window as unknown as { open: unknown }).open = open;
    const onDelete = vi.fn();
    mount(
      <AttachmentGallery
        attachments={[att({ id: 'a', filename: 'shot.png', mime: 'image/png' })]}
        isLoading={false}
        isError={false}
        error={null}
        onDelete={onDelete}
      />,
    );
    await settle();
    const img = container.querySelector('img[alt="shot.png"]') as HTMLImageElement;
    expect(img).not.toBeNull();
    // focusable + accessible name, like the file tile it copies
    expect(img.getAttribute('role')).toBe('button');
    expect(img.tabIndex).toBe(0);
    expect(img.getAttribute('aria-label')).toBe('Open shot.png');
    // the thumbnail's own fetch already happened on mount; nothing opened yet
    expect(mockApi.attachments.blob).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    act(() => img.click());
    await settle();
    // clicking opens the AUTHED bytes — a fresh fetch, same mechanism as the file tile
    expect(mockApi.attachments.blob).toHaveBeenCalledTimes(2);
    expect(mockApi.attachments.blob).toHaveBeenLastCalledWith('a');
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0][0])).toMatch(/^blob:/);
    expect(String(open.mock.calls[0][0])).not.toContain('token');
    expect(img.getAttribute('src')).not.toContain('token');
    // and the click never reached Delete: no confirm step armed, onDelete never fired
    expect(onDelete).not.toHaveBeenCalled();
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Keep')).toBe(false);
  });

  it('a blob fetch failure shows an honest could-not-load box, not a broken image', async () => {
    mockApi.attachments.blob.mockRejectedValue({ message: 'nope', status: 500 });
    mount(<AttachmentGallery attachments={[att({ id: 'a' })]} isLoading={false} isError={false} error={null} onDelete={() => {}} />);
    await settle();
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelector('[aria-label="before.jpg (couldn\'t load)"]')).not.toBeNull();
  });
});
