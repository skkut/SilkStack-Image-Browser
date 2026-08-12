import { useState, type ComponentType } from 'react';
import DevAutoTaggingTester from './DevAutoTaggingTester';
import DevSemanticSearchTester from './DevSemanticSearchTester';

/**
 * Every tool available in the dev-tools window. The `id` doubles as the
 * `?devtools=<id>` query param used to open a specific tool — add new
 * testers here and they appear in the switcher automatically.
 */
interface DevToolDef {
  id: string;
  label: string;
  Component: ComponentType;
}

const DEV_TOOLS: DevToolDef[] = [
  { id: 'auto-tag', label: 'Auto-Tag', Component: DevAutoTaggingTester },
  { id: 'semantic-search', label: 'Semantic Search', Component: DevSemanticSearchTester },
];

/**
 * Dev-tools window shell (`?devtools=<tool>`, opened from the main app via
 * Ctrl+Y). Hosts every tester behind a tab switcher.
 *
 * Panes are lazy-mounted on first visit and then kept alive (hidden, not
 * unmounted): mounting both at once would initialize every engine eagerly,
 * while remounting on each switch would re-run each tester's setup — for the
 * semantic search tester that means re-initializing the WebLLM worker and
 * re-restoring the vector index on every tab flip.
 */
export default function DevToolsShell({ initialTool }: { initialTool: string }) {
  const [activeId, setActiveId] = useState(() => {
    const known = DEV_TOOLS.some((tool) => tool.id === initialTool);
    return known ? initialTool : DEV_TOOLS[0].id;
  });
  const [mountedIds, setMountedIds] = useState(() => new Set([activeId]));

  const activate = (id: string) => {
    setActiveId(id);
    setMountedIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  };

  return (
    <div className="h-full flex flex-col">
      <nav className="flex items-center gap-2 px-4 py-2 bg-gray-900 border-b border-gray-700">
        {DEV_TOOLS.map((tool) => {
          const isActive = tool.id === activeId;
          return (
            <button
              key={tool.id}
              type="button"
              onClick={() => activate(tool.id)}
              aria-pressed={isActive}
              className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                isActive
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700'
              }`}
            >
              {tool.label}
            </button>
          );
        })}
      </nav>
      {DEV_TOOLS.map((tool) => {
        if (!mountedIds.has(tool.id)) return null;
        const ToolComponent = tool.Component;
        const isActive = tool.id === activeId;
        return (
          <div
            key={tool.id}
            data-testid={`pane-${tool.id}`}
            className={isActive ? 'flex-1 min-h-0 overflow-auto' : undefined}
            style={{ display: isActive ? undefined : 'none' }}
          >
            <ToolComponent />
          </div>
        );
      })}
    </div>
  );
}
