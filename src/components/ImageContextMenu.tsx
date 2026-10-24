import React from 'react';
import { CheckSquare, Copy, ExternalLink, Folder, Layers } from 'lucide-react';
import type { ContextMenuState } from '../hooks/useContextMenu';

/**
 * The right-click menu for an image.
 *
 * The same item list the library grid, the table and the stacks view render,
 * factored out for the popped-out stack window — a separate renderer with no
 * library around it, where every action must be one an image can answer by
 * itself. That is why nothing here reads the image store: copying metadata and
 * paths works from the image object and its directory path alone, and the one
 * store-dependent item ("Open Stack in New Window") is both optional and
 * gated by the flag the hook resolves when the menu opens.
 *
 * The `context-menu-class` marker is what `useContextMenu`'s click-outside
 * handler looks for — without it, clicking an item would close the menu before
 * the item's own handler ran.
 *
 * "Select All in Stack" stays store-blind too: the stack's membership arrives
 * in the menu state (`stackImageIds`), and the caller supplies the handler
 * because selection is renderer-local in the stack window.
 */
export interface ImageContextMenuProps {
  contextMenu: ContextMenuState;
  onCopyImage: () => void;
  onCopyPrompt: () => void;
  onCopyNegativePrompt: () => void;
  onCopySeed: () => void;
  onCopyModel: () => void;
  onCopyRawMetadata: () => void;
  onCopyPath: () => void;
  onOpenWithNativeViewer: () => void;
  onShowInFolder: () => void;
  /**
   * Pop the right-clicked image's stack out into a new window.
   *
   * Omitted by callers that are already a stack window — there is nothing to
   * pop out, and their store holds no images for the hook to resolve against.
   */
  onOpenStackInNewWindow?: () => void;
  /**
   * Select every image in the right-clicked image's stack. Rendered only when
   * the menu state carries the stack's members.
   */
  onSelectAllInStack?: () => void;
}

const ITEM_CLASS =
  'w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2';

const ImageContextMenu: React.FC<ImageContextMenuProps> = ({
  contextMenu,
  onCopyImage,
  onCopyPrompt,
  onCopyNegativePrompt,
  onCopySeed,
  onCopyModel,
  onCopyRawMetadata,
  onCopyPath,
  onOpenWithNativeViewer,
  onShowInFolder,
  onOpenStackInNewWindow,
  onSelectAllInStack,
}) => {
  if (!contextMenu.visible) return null;

  const image = contextMenu.image;
  const metadata = image?.metadata as Record<string, unknown> | undefined;
  const hasPrompt = !!(image?.prompt || metadata?.prompt);
  const hasNegativePrompt = !!(image?.negativePrompt || metadata?.negativePrompt);
  const hasSeed = !!(image?.seed || metadata?.seed);
  const hasModel = !!(image?.models?.[0] || metadata?.model);

  return (
    <div
      className="fixed z-[60] bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 min-w-[160px] context-menu-class"
      style={{ left: contextMenu.x, top: contextMenu.y }}
    >
      <button onClick={onCopyImage} className={ITEM_CLASS}>
        <Copy className="w-4 h-4" />
        Copy to Clipboard
      </button>

      <div className="border-t border-gray-600 my-1"></div>

      <button onClick={onCopyPrompt} className={ITEM_CLASS} disabled={!hasPrompt}>
        <Copy className="w-4 h-4" />
        Copy Prompt
      </button>
      <button
        onClick={onCopyNegativePrompt}
        className={ITEM_CLASS}
        disabled={!hasNegativePrompt}
      >
        <Copy className="w-4 h-4" />
        Copy Negative Prompt
      </button>
      <button onClick={onCopySeed} className={ITEM_CLASS} disabled={!hasSeed}>
        <Copy className="w-4 h-4" />
        Copy Seed
      </button>
      <button onClick={onCopyModel} className={ITEM_CLASS} disabled={!hasModel}>
        <Copy className="w-4 h-4" />
        Copy Model
      </button>

      <div className="border-t border-gray-600 my-1"></div>

      <button
        onClick={onCopyRawMetadata}
        className={ITEM_CLASS}
        disabled={!image?.metadata}
      >
        <Copy className="w-4 h-4" />
        Copy Raw Metadata
      </button>

      <div className="border-t border-gray-600 my-1"></div>

      {/* Both stack items are decided when the menu opens (see
          useContextMenu): one needs Electron child windows, the other only
          needs a stack of 2+ members. */}
      {contextMenu.stackImageIds && contextMenu.stackImageIds.length > 1 && onSelectAllInStack && (
        <button onClick={onSelectAllInStack} className={ITEM_CLASS}>
          <CheckSquare className="w-4 h-4" />
          Select All {contextMenu.stackImageIds.length} Images in Stack
        </button>
      )}
      {contextMenu.canOpenStackInNewWindow && onOpenStackInNewWindow && (
        <button onClick={onOpenStackInNewWindow} className={ITEM_CLASS}>
          <Layers className="w-4 h-4" />
          Open Stack in New Window
        </button>
      )}

      <button onClick={onCopyPath} className={ITEM_CLASS}>
        <Copy className="w-4 h-4" />
        Copy Image Path
      </button>

      <button onClick={onOpenWithNativeViewer} className={ITEM_CLASS}>
        <ExternalLink className="w-4 h-4" />
        Open in Native Viewer
      </button>

      <button onClick={onShowInFolder} className={ITEM_CLASS}>
        <Folder className="w-4 h-4" />
        Show in Folder
      </button>
    </div>
  );
};

export default ImageContextMenu;
