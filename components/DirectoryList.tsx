import React, { useCallback, useEffect, useState } from "react";
import { Directory } from "../types";
import { useImageStore } from "../store/useImageStore";
import {
  FolderOpen,
  RotateCcw,
  Trash2,
  ChevronDown,
  Folder,
  FolderTree,
  X,
  EyeOff,
  Palette,
} from "lucide-react";
import { normalizePath } from "../utils/pathUtils";

interface DirectoryListProps {
  directories: Directory[];
  onRemoveDirectory: (directoryId: string) => void;
  onUpdateDirectory: (directoryId: string, subPath?: string) => void;
  refreshingDirectories?: Set<string>;
  onToggleFolderSelection?: (path: string, ctrlKey: boolean) => void;
  onClearFolderSelection?: () => void;
  isFolderSelected?: (path: string) => boolean;
  selectedFolders?: Set<string>;
  includeSubfolders?: boolean;
  onToggleIncludeSubfolders?: () => void;
  isIndexing?: boolean;
  scanSubfolders?: boolean;
  excludedFolders?: Set<string>;
  onExcludeFolder?: (path: string) => void;
  isCollapsed?: boolean;
}

interface SubfolderNode {
  name: string;
  path: string;
  relativePath: string;
}

const toForwardSlashes = (path: string) => normalizePath(path);
const makeNodeKey = (rootId: string, relativePath: string) =>
  `${rootId}::${relativePath === "" ? "." : relativePath}`;

const getRelativePath = (rootPath: string, targetPath: string) => {
  const normalizedRoot = toForwardSlashes(rootPath);
  const normalizedTarget = toForwardSlashes(targetPath);
  if (!normalizedRoot) {
    return normalizedTarget;
  }
  if (normalizedRoot === normalizedTarget) {
    return "";
  }
  if (normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return normalizedTarget.slice(normalizedRoot.length + 1);
  }
  return normalizedTarget;
};

export default function DirectoryList({
  directories,
  onRemoveDirectory,
  onUpdateDirectory,
  refreshingDirectories,
  onToggleFolderSelection,
  onClearFolderSelection,
  isFolderSelected,
  selectedFolders = new Set<string>(),
  includeSubfolders = true,
  onToggleIncludeSubfolders,
  isIndexing = false,
  scanSubfolders = false,
  excludedFolders,
  onExcludeFolder,
  isCollapsed = false,
}: DirectoryListProps) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [subfolderCache, setSubfolderCache] = useState<
    Map<string, SubfolderNode[]>
  >(new Map());
  const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set());
  const [autoMarkedNodes, setAutoMarkedNodes] = useState<Set<string>>(
    new Set(),
  );
  const [isExpanded, setIsExpanded] = useState(true);
  const [autoExpandedDirs, setAutoExpandedDirs] = useState<Set<string>>(
    new Set(),
  );
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    path: string;
  } | null>(null);
  const [activeColorPicker, setActiveColorPicker] = useState<string | null>(
    null,
  );

  const { folderPreferences, setFolderColor } = useImageStore();

  const loadSubfolders = useCallback(
    async (nodeKey: string, nodePath: string, rootDirectory: Directory) => {
      try {
        setLoadingNodes((prev) => {
          const next = new Set(prev);
          next.add(nodeKey);
          return next;
        });

        const isElectron =
          typeof window !== "undefined" && (window as any).electronAPI;
        if (isElectron && (window as any).electronAPI.listSubfolders) {
          const result = await (window as any).electronAPI.listSubfolders(
            nodePath,
          );

          if (result.success) {
            const subfolders: SubfolderNode[] = (result.subfolders || []).map(
              (subfolder: { name: string; path: string }) => ({
                name: subfolder.name,
                path: subfolder.path,
                relativePath: getRelativePath(
                  rootDirectory.path,
                  subfolder.path,
                ),
              }),
            );

            setSubfolderCache((prev) => {
              const next = new Map(prev);
              next.set(nodeKey, subfolders);
              return next;
            });
          } else {
            console.error("Failed to load subfolders:", result.error);
          }
        }
      } catch (error) {
        console.error("Error loading subfolders:", error);
      } finally {
        setLoadingNodes((prev) => {
          const next = new Set(prev);
          next.delete(nodeKey);
          return next;
        });
      }
    },
    [],
  );

  // Auto-expand and load subfolders for newly added directories
  useEffect(() => {
    if (!scanSubfolders || !directories.length) return;

    directories.forEach((dir) => {
      const rootKey = makeNodeKey(dir.id, "");

      // Only auto-expand if not already expanded/loading and not previously auto-expanded
      if (
        !expandedNodes.has(rootKey) &&
        !loadingNodes.has(rootKey) &&
        !autoExpandedDirs.has(dir.id)
      ) {
        setAutoExpandedDirs((prev) => new Set(prev).add(dir.id));
        setExpandedNodes((prev) => new Set(prev).add(rootKey));

        // Load subfolders if not already cached
        if (!subfolderCache.has(rootKey)) {
          void loadSubfolders(rootKey, dir.path, dir);
        }
      }
    });
  }, [
    directories,
    scanSubfolders,
    expandedNodes,
    loadingNodes,
    subfolderCache,
    autoExpandedDirs,
    loadSubfolders,
  ]);

  const handleToggleNode = useCallback(
    (nodeKey: string, nodePath: string, rootDirectory: Directory) => {
      let shouldLoad = false;
      setExpandedNodes((prev) => {
        const next = new Set(prev);
        if (next.has(nodeKey)) {
          next.delete(nodeKey);
        } else {
          next.add(nodeKey);
          if (!subfolderCache.has(nodeKey)) {
            shouldLoad = true;
          }
        }
        return next;
      });

      if (shouldLoad) {
        void loadSubfolders(nodeKey, nodePath, rootDirectory);
      }
    },
    [loadSubfolders, subfolderCache],
  );

  const handleOpenInExplorer = async (path: string) => {
    try {
      const isElectron =
        typeof window !== "undefined" && (window as any).electronAPI;
      if (isElectron && (window as any).electronAPI.showItemInFolder) {
        await (window as any).electronAPI.showItemInFolder(path);
      } else {
        alert(
          "This feature requires the desktop app. Please use the AI Images Browser application.",
        );
      }
    } catch (error) {
      console.error("Error opening folder:", error);
      alert("Failed to open folder. Please check the path.");
    }
  };

  const handleFolderClick = useCallback(
    (path: string, event: React.MouseEvent) => {
      console.log(
        "[DirectoryList] handleClick:",
        path,
        "isCollapsed:",
        isCollapsed,
      );
      event.stopPropagation();
      if (!onToggleFolderSelection) {
        console.log("[DirectoryList] onToggleFolderSelection is missing!");
        return;
      }
      onToggleFolderSelection(path, event.ctrlKey);
    },
    [onToggleFolderSelection, isCollapsed],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent, path: string) => {
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({
        visible: true,
        x: event.clientX,
        y: event.clientY,
        path,
      });
    },
    [],
  );

  // Click outside handler to close context menu
  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null);
    if (contextMenu) {
      window.addEventListener("click", handleClickOutside, true);
      return () =>
        window.removeEventListener("click", handleClickOutside, true);
    }
  }, [contextMenu]);

  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const handleDragOver = useCallback(
    (e: React.DragEvent, path: string) => {
      e.preventDefault();
      e.stopPropagation();
      // Enable copy/move for files
      e.dataTransfer.dropEffect = "copy";
      if (dropTarget !== path) {
        console.log("[DirectoryList] DragOver:", path);
        setDropTarget(path);
      }
    },
    [dropTarget],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent, targetPath: string, rootId: string) => {
      console.log("[DirectoryList] Drop on:", targetPath);
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);

      const isElectron =
        typeof window !== "undefined" && (window as any).electronAPI;
      if (!isElectron) {
        console.log("[DirectoryList] Not electron");
        return;
      }

      let filesToMove: { sourcePath: string; name: string }[] = [];

      // Check for internal drag data (Store State - Preferred for robustness)
      const draggedItems = useImageStore.getState().draggedItems;
      if (draggedItems && draggedItems.length > 0) {
        console.log(
          "[DirectoryList] Found internal drag items (via store):",
          draggedItems.length,
        );
        filesToMove = draggedItems;
      } else {
        // Fallback to dataTransfer if store is empty (e.g. valid external drag or store cleared too early)
        const internalData = e.dataTransfer.getData(
          "application/x-image-metahub-items",
        );
        if (internalData) {
          console.log(
            "[DirectoryList] Found internal drag data (via dataTransfer)",
          );
          try {
            filesToMove = JSON.parse(internalData);
          } catch (err) {
            console.error("Failed to parse internal drag data", err);
          }
        } else if (e.dataTransfer.files.length > 0) {
          console.log(
            "[DirectoryList] Found external/native files:",
            e.dataTransfer.files.length,
          );
          // External files
          filesToMove = Array.from(e.dataTransfer.files)
            .map((f) => {
              // Electron's File object has a 'path' property, but sometimes it needs to be accessed differently or might be missing in some contexts?
              // In newer Electron versions, we might need webUtils.getPathForFile(f) in the main process, but here in renderer 'path' usually works.
              // Let's explicitly cast and check given the error.
              const p = (f as any).path;
              console.log("[DirectoryList] File path extraction:", f.name, p);
              return {
                sourcePath: p,
                name: f.name,
              };
            })
            .filter((f) => !!f.sourcePath); // Filter out any where path is missing
        } else {
          console.log("[DirectoryList] No valid data found in drop");
        }
      }

      if (filesToMove.length === 0) return;

      try {
        const result = await (window as any).electronAPI.moveFiles({
          files: filesToMove,
          targetDir: targetPath,
        });

        if (result.success) {
          console.log("[DirectoryList] Move successful, refreshing...");
          // Check if we need to refresh the current view (if source or target is current)
          // Since we don't know the current view here easily without props,
          // we at least refresh the target folder if it's the one currently selected?
          // Actually onUpdateDirectory triggers a scan.
          // Refresh target directory
          onUpdateDirectory(rootId, targetPath);

          // Remove moved images from store to update specific thumbnail view immediately
          const movedPaths = result.results
            .filter((r: any) => r.success)
            .map((r: any) => r.sourcePath);

          if (movedPaths.length > 0) {
            useImageStore.getState().removeImagesByPaths(movedPaths);
          }

          // For now, this is a good start.
        } else {
          console.error("Move failed:", result.error);
          alert(`Failed to move files: ${result.error}`);
        }
      } catch (error) {
        console.error("Move error:", error);
        alert("An error occurred while moving files.");
      }
    },
    [onUpdateDirectory],
  );

  const PREDEFINED_COLORS = [
    { name: "None", value: undefined },
    { name: "Pearl", value: "#f1f5f9" },
    { name: "Slate", value: "#64748b" },
    { name: "Tan", value: "#d6d3d1" },
    { name: "Coffee", value: "#44403c" },
    { name: "Deep Red", value: "#991b1b" },
    { name: "Red", value: "#ef4444" },
    { name: "Orange", value: "#f97316" },
    { name: "Gold", value: "#b45309" },
    { name: "Yellow", value: "#facc15" },
    { name: "Lime", value: "#a3e635" },
    { name: "Green", value: "#22c55e" },
    { name: "Forest", value: "#166534" },
    { name: "Teal", value: "#14b8a6" },
    { name: "Sky", value: "#0ea5e9" },
    { name: "Blue", value: "#2563eb" },
    { name: "Navy", value: "#1e3a8a" },
    { name: "Violet", value: "#8b5cf6" },
    { name: "Magenta", value: "#d946ef" },
    { name: "Pink", value: "#fb7185" },
  ];

  const renderColorPicker = (path: string) => (
    <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-600 rounded-md shadow-xl z-[100] p-2 grid grid-cols-5 gap-1.5 w-40">
      {PREDEFINED_COLORS.map((color) => (
        <button
          key={color.name}
          onClick={(e) => {
            e.stopPropagation();
            setFolderColor(path, color.value);
            setActiveColorPicker(null);
          }}
          className={`w-4 h-4 rounded-full border border-gray-500 hover:scale-110 transition-transform ${!color.value ? 'bg-transparent relative after:content-["/"] after:absolute after:inset-0 after:flex after:items-center after:justify-center after:text-[10px] after:text-gray-400' : ""}`}
          style={{ backgroundColor: color.value }}
          title={color.name}
        />
      ))}
    </div>
  );

  const renderSubfolderList = useCallback(
    (rootDirectory: Directory, parentKey: string): React.ReactNode => {
      const children = subfolderCache.get(parentKey) || [];

      return children.map((child) => {
        const childKey = makeNodeKey(rootDirectory.id, child.relativePath);
        const isExpandedNode = expandedNodes.has(childKey);
        const isLoadingNode = loadingNodes.has(childKey);
        const grandchildren = subfolderCache.get(childKey) || [];
        const isSelected = isFolderSelected
          ? isFolderSelected(child.path)
          : false;

        // Skip excluded folders
        if (excludedFolders && excludedFolders.has(normalizePath(child.path))) {
          return null;
        }

        const hasSubfolders =
          isLoadingNode ||
          !subfolderCache.has(childKey) ||
          (subfolderCache.get(childKey)?.length ?? 0) > 0;

        return (
          <li key={childKey} className="py-1">
            <div
              className={`flex items-center cursor-pointer rounded px-2 py-1 transition-colors group ${
                isSelected
                  ? "bg-blue-600/30 hover:bg-blue-600/40"
                  : dropTarget === child.path
                    ? "bg-blue-500/40"
                    : "hover:bg-gray-700/50"
              }`}
              onClick={(e) => handleFolderClick(child.path, e)}
              onContextMenu={(e) => handleContextMenu(e, child.path)}
              title={
                rootDirectory.isConnected === false
                  ? "Parent directory disconnected"
                  : ""
              }
              style={{ opacity: rootDirectory.isConnected === false ? 0.5 : 1 }}
              onDragOver={(e) => handleDragOver(e, child.path)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, child.path, rootDirectory.id)}
            >
              {hasSubfolders ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleNode(childKey, child.path, rootDirectory);
                  }}
                  className="text-gray-500 hover:text-gray-300 transition-colors mr-1 flex-shrink-0"
                  title={isExpandedNode ? "Hide subfolders" : "Show subfolders"}
                >
                  <ChevronDown
                    className={`w-3 h-3 transition-transform ${isExpandedNode ? "rotate-0" : "-rotate-90"}`}
                  />
                </button>
              ) : (
                <div className="w-4 mr-1 flex-shrink-0" /> // Spacer
              )}

              <Folder
                className="w-3 h-3 mr-2"
                style={{
                  color:
                    folderPreferences.get(normalizePath(child.path))?.color ||
                    "#9ca3af",
                }}
              />
              <span className="text-sm text-gray-300 truncate flex-1">
                {child.name}
              </span>

              {/* Action Buttons (Visible on Hover) */}
              <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity ml-2">
                <div className="relative flex items-center">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveColorPicker(
                        activeColorPicker === child.path ? null : child.path,
                      );
                    }}
                    className={`p-1 rounded transition-colors ${
                      activeColorPicker === child.path
                        ? "text-blue-400 bg-gray-600"
                        : "text-gray-400 hover:text-white hover:bg-gray-600"
                    }`}
                    title="Set folder color"
                  >
                    <Palette className="w-3 h-3" />
                  </button>
                  {activeColorPicker === child.path &&
                    renderColorPicker(child.path)}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    // Refresh via parent, passing specific subpath
                    onUpdateDirectory(rootDirectory.id, child.path);

                    // Also refresh subfolders for this specific node
                    setSubfolderCache((prev) => {
                      const next = new Map(prev);
                      next.delete(childKey);
                      return next;
                    });
                    // If it was expanded or has subfolders, reload them
                    // Even if it wasn't, checking again is good practice on refresh
                    void loadSubfolders(childKey, child.path, rootDirectory);
                  }}
                  disabled={isIndexing}
                  className={`p-1 rounded transition-colors ${
                    isIndexing
                      ? "text-gray-600 cursor-not-allowed"
                      : "text-gray-400 hover:text-white hover:bg-gray-600"
                  }`}
                  title="Refresh folder"
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
                {onExcludeFolder && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onExcludeFolder(normalizePath(child.path));
                    }}
                    disabled={isIndexing}
                    className={`p-1 rounded transition-colors ${
                      isIndexing
                        ? "text-gray-600 cursor-not-allowed"
                        : "text-gray-400 hover:text-red-400 hover:bg-gray-600"
                    }`}
                    title="Exclude folder"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
            {isExpandedNode && hasSubfolders && (
              <ul className="ml-4 mt-1 space-y-1 border-l border-gray-700 pl-2">
                {isLoadingNode ? (
                  <li className="text-xs text-gray-500 italic py-1">
                    Loading subfolders...
                  </li>
                ) : grandchildren.length > 0 ? (
                  renderSubfolderList(rootDirectory, childKey)
                ) : null}
              </ul>
            )}
          </li>
        );
      });
    },
    [
      expandedNodes,
      handleFolderClick,
      handleContextMenu,
      handleToggleNode,
      isFolderSelected,
      loadingNodes,
      subfolderCache,
      excludedFolders,
      dropTarget,
      handleDragOver,
      handleDragLeave,
      handleDrop,
    ],
  );

  if (isCollapsed) {
    return (
      <ul className="flex flex-col items-center space-y-3 w-full px-1 pt-2">
        {directories
          .filter((dir) => dir.isConnected !== false)
          .map((dir) => {
            // Recursive helper to render icons for the root directory and its expanded subfolders
            const renderCollapsedIcons = (path: string, rootDir: Directory) => {
              // Skip if this specific subfolder is excluded
              if (
                path !== rootDir.path &&
                excludedFolders?.has(normalizePath(path))
              ) {
                return [];
              }

              const key = makeNodeKey(
                rootDir.id,
                getRelativePath(rootDir.path, path),
              );
              const children = subfolderCache.get(key) || [];
              const icons: React.ReactNode[] = [];
              const isSelected = isFolderSelected
                ? isFolderSelected(path)
                : false;
              const pref = folderPreferences.get(normalizePath(path));

              icons.push(
                <li
                  key={path}
                  className="w-full flex justify-center relative group"
                >
                  <button
                    onClick={(e) => handleFolderClick(path, e)}
                    onContextMenu={(e) => handleContextMenu(e, path)}
                    onDragOver={(e) => handleDragOver(e, path)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, path, rootDir.id)}
                    className={`p-2 rounded-xl transition-all ${
                      isSelected
                        ? "bg-blue-600/40 shadow-lg shadow-blue-500/20 text-white ring-1 ring-blue-400/40"
                        : dropTarget === path
                          ? "bg-blue-500/40"
                          : "bg-white/10 hover:bg-white/15 text-gray-400 ring-1 ring-gray-400/30 hover:ring-gray-300/50"
                    }`}
                    title={`${dir.name}${path !== dir.path ? ` > ${path.split(/[/\\]/).pop()}` : ""}`}
                  >
                    <Folder
                      className="w-6 h-6 transition-transform group-hover:scale-110"
                      style={{ color: pref?.color || "#9ca3af" }}
                    />
                  </button>
                </li>,
              );

              // If the folder is expanded in the main sidebar, show its subfolders' icons
              if (expandedNodes.has(key)) {
                children.forEach((child) => {
                  icons.push(
                    ...(renderCollapsedIcons(child.path, rootDir) as any),
                  );
                });
              }

              return icons;
            };

            return renderCollapsedIcons(dir.path, dir);
          })}
      </ul>
    );
  }

  return (
    <div className="border-b border-gray-700">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setIsExpanded((prev) => !prev);
          }
        }}
        className="w-full flex items-center justify-between p-4 hover:bg-gray-700/50 transition-colors"
        aria-expanded={isExpanded}
      >
        <div className="flex items-center space-x-2">
          <span className="text-gray-300 font-medium">Folders</span>
          <span className="text-xs bg-gray-700 text-gray-400 px-2 py-0.5 rounded border border-gray-600">
            {directories.length}
          </span>
          {onToggleIncludeSubfolders && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleIncludeSubfolders();
              }}
              className={`p-1.5 rounded-md border transition-all ${
                includeSubfolders
                  ? "bg-blue-600/20 border-blue-500/30 text-blue-400 hover:bg-blue-600/30"
                  : "bg-transparent border-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-700/50"
              }`}
              title={
                includeSubfolders
                  ? "Including subfolders (Recursive)"
                  : "Direct folder only (Flat)"
              }
            >
              {includeSubfolders ? (
                <FolderTree className="w-3.5 h-3.5" />
              ) : (
                <Folder className="w-3.5 h-3.5" />
              )}
            </button>
          )}
          {selectedFolders.size > 0 && onClearFolderSelection && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClearFolderSelection();
              }}
              className="p-1 rounded-full text-gray-500 hover:text-red-400 hover:bg-gray-700/50 transition-colors"
              title="Clear folder selection"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <ChevronDown
          className={`w-4 h-4 transform transition-transform ${isExpanded ? "rotate-180" : ""}`}
        />
      </div>
      {isExpanded && (
        <div className="px-4 pb-4">
          <ul className="space-y-1">
            {directories
              .filter((dir) => dir.isConnected !== false)
              .map((dir) => {
                const rootKey = makeNodeKey(dir.id, "");
                const isRootExpanded = expandedNodes.has(rootKey);
                const isRootLoading = loadingNodes.has(rootKey);
                const rootChildren = subfolderCache.get(rootKey) || [];
                const isRefreshing =
                  refreshingDirectories?.has(dir.id) ?? false;
                const isRootSelected = isFolderSelected
                  ? isFolderSelected(dir.path)
                  : false;

                // Determine if we should show the expander
                // Show if loading, or if not yet loaded (not in cache), or if loaded and has children
                const hasSubfolders =
                  isRootLoading ||
                  !subfolderCache.has(rootKey) ||
                  (subfolderCache.get(rootKey)?.length ?? 0) > 0;

                return (
                  <li key={dir.id}>
                    <div
                      className={`flex items-center justify-between p-2 rounded-md transition-colors ${
                        isRootSelected
                          ? "bg-blue-600/30 hover:bg-blue-600/40"
                          : dropTarget === dir.path
                            ? "bg-blue-500/40"
                            : "bg-gray-800 hover:bg-gray-700/50"
                      }`}
                      onDragOver={(e) => handleDragOver(e, dir.path)}
                      onDragLeave={handleDragLeave}
                      onDrop={(e) => handleDrop(e, dir.path, dir.id)}
                    >
                      <div className="flex items-center overflow-hidden flex-1">
                        {hasSubfolders ? (
                          <button
                            onClick={() =>
                              handleToggleNode(rootKey, dir.path, dir)
                            }
                            className="text-gray-400 hover:text-gray-300 transition-colors flex-shrink-0"
                            title={
                              isRootExpanded
                                ? "Hide subfolders"
                                : "Show subfolders"
                            }
                          >
                            <ChevronDown
                              className={`w-4 h-4 transition-transform ${isRootExpanded ? "rotate-0" : "-rotate-90"}`}
                            />
                          </button>
                        ) : (
                          <div className="w-4 h-4 ml-1 flex-shrink-0" /> // Spacer
                        )}

                        <FolderOpen
                          className="w-4 h-4 flex-shrink-0 ml-1"
                          style={{
                            color:
                              folderPreferences.get(normalizePath(dir.path))
                                ?.color || "#9ca3af",
                          }}
                        />
                        <button
                          onClick={(e) => handleFolderClick(dir.path, e)}
                          onContextMenu={(e) => handleContextMenu(e, dir.path)}
                          className={`ml-2 text-sm truncate text-left transition-colors flex-1 ${
                            isRootSelected
                              ? "text-white"
                              : "text-gray-300 hover:text-gray-100"
                          }`}
                          title={`Select folder: ${dir.path}`}
                        >
                          {dir.name}
                        </button>
                      </div>
                      <div className="flex items-center space-x-1 flex-shrink-0">
                        <div className="relative flex items-center">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveColorPicker(
                                activeColorPicker === dir.path
                                  ? null
                                  : dir.path,
                              );
                            }}
                            className={`p-1 rounded transition-colors ${
                              activeColorPicker === dir.path
                                ? "text-blue-400 bg-gray-700/50"
                                : "text-gray-400 hover:text-white hover:bg-gray-700/50"
                            }`}
                            title="Set folder color"
                          >
                            <Palette className="w-4 h-4" />
                          </button>
                          {activeColorPicker === dir.path &&
                            renderColorPicker(dir.path)}
                        </div>
                        <button
                          onClick={() => {
                            onUpdateDirectory(dir.id);
                            // Also refresh subfolders
                            setSubfolderCache((prev) => {
                              const next = new Map(prev);
                              next.delete(rootKey);
                              return next;
                            });
                            void loadSubfolders(rootKey, dir.path, dir);
                          }}
                          disabled={isIndexing || isRefreshing}
                          className={`p-1 rounded transition-colors ${
                            isRefreshing
                              ? "text-blue-400"
                              : isIndexing
                                ? "text-gray-600 cursor-not-allowed"
                                : "text-gray-400 hover:text-gray-50 hover:bg-gray-700/50"
                          }`}
                          title={
                            isRefreshing
                              ? "Refreshing folder"
                              : isIndexing
                                ? "Cannot refresh during indexing"
                                : "Refresh folder"
                          }
                        >
                          <RotateCcw
                            className={`w-4 h-4 ${isRefreshing ? "animate-spin" : ""}`}
                          />
                        </button>
                        <button
                          onClick={() => onRemoveDirectory(dir.id)}
                          disabled={isIndexing || isRefreshing}
                          className={`p-1 rounded transition-colors ${
                            isRefreshing || isIndexing
                              ? "text-gray-600 cursor-not-allowed"
                              : "text-gray-400 hover:text-red-500 hover:bg-gray-700/50"
                          }`}
                          title={
                            isRefreshing
                              ? "Cannot remove while refreshing"
                              : isIndexing
                                ? "Cannot remove during indexing"
                                : "Remove folder"
                          }
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {isRootExpanded && hasSubfolders && (
                      <div className="ml-4 mt-1 space-y-1 border-l-2 border-gray-700 pl-2">
                        {scanSubfolders ? (
                          <>
                            <ul className="ml-3 space-y-1">
                              {isRootLoading ? (
                                <li className="text-xs text-gray-500 italic py-1">
                                  Loading subfolders...
                                </li>
                              ) : rootChildren.length > 0 ? (
                                renderSubfolderList(dir, rootKey)
                              ) : null}
                            </ul>
                          </>
                        ) : (
                          <div className="text-xs text-gray-500 italic py-1">
                            No subfolders (folder loaded without "Scan
                            Subfolders")
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
          </ul>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed bg-gray-800 border border-gray-600 rounded shadow-lg z-50 py-1 min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 flex items-center gap-2"
            onClick={() => {
              handleOpenInExplorer(contextMenu.path);
              setContextMenu(null);
            }}
          >
            <FolderOpen className="w-4 h-4" />
            Open in Explorer
          </button>

          <button
            className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 flex items-center gap-2"
            onClick={() => {
              // Find root directory for this path to trigger refresh
              const rootDir = directories.find((d) =>
                contextMenu.path.startsWith(d.path),
              );
              if (rootDir) {
                onUpdateDirectory(rootDir.id, contextMenu.path);
              } else {
                // Fallback or specific logic if needed
                console.warn(
                  "Could not find root directory for",
                  contextMenu.path,
                );
              }
              setContextMenu(null);
            }}
            disabled={isIndexing}
          >
            <RotateCcw
              className={`w-4 h-4 ${isIndexing ? "text-gray-600" : ""}`}
            />
            Refresh Folder
          </button>

          {onExcludeFolder && (
            <button
              className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 flex items-center gap-2"
              onClick={() => {
                // No confirmation dialog as requested
                onExcludeFolder(normalizePath(contextMenu.path));
                setContextMenu(null);
              }}
            >
              <EyeOff className="w-4 h-4" />
              Exclude Folder
            </button>
          )}
        </div>
      )}
    </div>
  );
}
