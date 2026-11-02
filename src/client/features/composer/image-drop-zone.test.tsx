// @vitest-environment jsdom

import { act } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '@/lib/chat-protocol';
import { MAX_IMAGE_SIZE } from '@/lib/image-utils';
import { ImageDropZone } from './image-drop-zone';

const errors = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: errors } }));

let container: HTMLDivElement;
let root: Root;
let attachments: MessageAttachment[];
let accepted: ReturnType<typeof vi.fn<() => void>>;
const image = () => new File(['image data'], 'screenshot.png', { type: 'image/png' });

function render(identity = 'chat-a', disabled = false) {
  return act(() => {
    root.render(
      <ImageDropZone
        dropIdentity={identity}
        disabled={disabled}
        label="Drop images to attach to your message"
        onDropAccepted={accepted}
        onAttachments={(added) => attachments.push(...added)}
      >
        <textarea onDrop={() => attachments.push({ id: 'duplicate' } as MessageAttachment)} />
        <span>Transcript</span>
      </ImageDropZone>
    );
  });
}

function drag(type: string, files: File[], target: Element = container.querySelector('textarea')!) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const dataTransfer = {
    items: files.map((file) => ({ kind: 'file', type: file.type })),
    files: type === 'drop' ? files : [],
    dropEffect: 'none',
  };
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  void act(() => target.dispatchEvent(event));
  return { event, dataTransfer };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  attachments = [];
  accepted = vi.fn();
  errors.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('ImageDropZone', () => {
  it('indicates an image drop and attaches each image once, including over the textarea', async () => {
    await render();
    const hover = drag('dragenter', [image()]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('attach');
    expect(drag('dragover', [image()]).dataTransfer.dropEffect).toBe('copy');
    expect(hover.event.defaultPrevented).toBe(true);
    drag('drop', [image(), image()]);
    expect(accepted).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')).toBeNull();
    await vi.waitFor(() => expect(attachments).toHaveLength(2));
    expect(attachments.map(({ name, data }) => ({ name, data }))).toEqual([
      { name: 'screenshot.png', data: 'aW1hZ2UgZGF0YQ==' },
      { name: 'screenshot.png', data: 'aW1hZ2UgZGF0YQ==' },
    ]);
  });

  it('keeps feedback while crossing children and clears it after leaving the view', async () => {
    await render();
    drag('dragenter', [image()], container.firstElementChild!);
    drag('dragenter', [image()]);
    drag('dragleave', [image()]);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    drag('dragleave', [image()], container.firstElementChild!);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('leaves text and internal drags alone and does not advertise disabled drops', async () => {
    await render();
    expect(drag('dragover', []).event.defaultPrevented).toBe(false);
    expect(
      drag('dragover', [new File(['hello'], 'notes.txt', { type: 'text/plain' })]).event
        .defaultPrevented
    ).toBe(false);
    expect(container.querySelector('[role="status"]')).toBeNull();
    await render('chat-a', true);
    drag('dragenter', [image()]);
    drag('drop', [image()], container.firstElementChild!);
    expect(accepted).not.toHaveBeenCalled();
    expect(attachments).toEqual([]);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('reports rejected images while attaching valid images from a mixed drop', async () => {
    await render();
    const oversized = image();
    Object.defineProperty(oversized, 'size', { value: MAX_IMAGE_SIZE + 1 });
    drag('drop', [oversized, image(), new File(['text'], 'notes.txt', { type: 'text/plain' })]);
    await vi.waitFor(() => expect(attachments).toHaveLength(2));
    expect(attachments[1]).toMatchObject({ name: 'notes.txt', data: 'text' });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('File too large'));
  });

  it('does not attach to another chat when a file finishes reading after a switch', async () => {
    let finishRead: (() => void) | undefined;
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
      finishRead = () => {
        Object.defineProperty(this, 'result', { value: 'data:image/png;base64,aW1hZ2U=' });
        this.dispatchEvent(new ProgressEvent('load'));
      };
    });
    try {
      await render();
      drag('drop', [image()]);
      await render('chat-b');
      await act(async () => finishRead?.());
      expect(attachments).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('leaves drops inside a portal to that portal instead of routing them to the underlying view', async () => {
    const portal = document.createElement('div');
    document.body.append(portal);
    const portalDrop = vi.fn();
    try {
      await act(() =>
        root.render(
          <ImageDropZone
            dropIdentity="board"
            label="New workspace"
            onAttachments={() => undefined}
            onDropAccepted={accepted}
          >
            {createPortal(<textarea onDrop={portalDrop} />, portal)}
          </ImageDropZone>
        )
      );
      drag('drop', [image()], portal.querySelector('textarea')!);
      expect(portalDrop).toHaveBeenCalledOnce();
      expect(accepted).not.toHaveBeenCalled();
    } finally {
      portal.remove();
    }
  });
});
