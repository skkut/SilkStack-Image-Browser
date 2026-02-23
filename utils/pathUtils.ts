/**
 * Normalizes a file system path for consistent use as keys in Maps and Sets.
 * 
 * - Replaces backslashes with forward slashes
 * - Removes trailing slashes
 * - Handles empty/null paths
 * - Converts to lowercase for case-insensitive comparison (recommended for Windows paths)
 */
export function normalizePath(path: string | null | undefined): string {
  if (!path) return '';
  
  // Replace all backslashes with forward slashes
  let normalized = path.replace(/\\/g, '/');
  
  // Remove trailing slash if it's not the root
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  
  // For Windows, paths are mostly case-insensitive. 
  // We use lowercase for the Map keys to ensure consistency.
  return normalized.toLowerCase();
}
