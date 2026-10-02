import { type IndexedImage } from '../types';

/**
 * Column sorting for the library's list view (ImageTable).
 *
 * The comparator lives here — not in the component — because the order it
 * produces is the library's own order while the list is on screen: the store
 * re-sorts `filteredImages` with it (see setTableSort in useImageStore), so
 * the viewer window / modal walks the same sequence the rows are drawn in.
 */

export type TableSortField =
  | 'filename'
  | 'model'
  | 'steps'
  | 'cfg'
  | 'size'
  | 'megapixel'
  | 'aspect'
  | 'seed'
  | 'filesize';

export type TableSortDirection = 'asc' | 'desc' | null;

/**
 * The pixel dimensions used by the resolution / megapixel / aspect columns.
 *
 * Parses the "WxH" string the indexer writes — ASCII 'x' (fileIndexer builds
 * `${width}x${height}`), with '×' accepted too since display-built strings use
 * it. When the string is absent or unusable, falls back to the metadata
 * width/height fields, so cached records that carry only those still sort.
 */
const parseDimensions = (image: IndexedImage): [number, number] => {
  const meta = image.metadata as any;
  const [w, h] = String(image.dimensions || meta?.dimensions || '').split(/[×x]/i).map(Number);
  if (w > 0 && h > 0) {
    return [w, h];
  }
  const width = meta?.width || meta?.normalizedMetadata?.width;
  const height = meta?.height || meta?.normalizedMetadata?.height;
  return [width || 0, height || 0];
};

/**
 * Returns the images ordered by `field`/`direction`, or the input array
 * unchanged when either is null (the "no column sort" state).
 *
 * Stable by construction: Array#sort is stable per spec, so equal keys keep
 * their incoming (header-sort) order — favorites-first, date ties and so on
 * stay exactly as the table drew them before this comparator moved here.
 */
export function applyTableSorting(
  images: IndexedImage[],
  field: TableSortField | null,
  direction: TableSortDirection,
): IndexedImage[] {
  if (!field || !direction) {
    return images;
  }

  return [...images].sort((a, b) => {
    let aValue: string | number;
    let bValue: string | number;

    switch (field) {
      case 'filename':
        aValue = a.handle.name.toLowerCase();
        bValue = b.handle.name.toLowerCase();
        break;
      case 'model':
        aValue = (a.models?.[0] || '').toLowerCase();
        bValue = (b.models?.[0] || '').toLowerCase();
        break;
      case 'steps': {
        const aSteps = a.steps || (a.metadata as any)?.steps || (a.metadata as any)?.normalizedMetadata?.steps || 0;
        const bSteps = b.steps || (b.metadata as any)?.steps || (b.metadata as any)?.normalizedMetadata?.steps || 0;
        aValue = aSteps;
        bValue = bSteps;
        break;
      }
      case 'cfg': {
        const aCfg = a.cfgScale || (a.metadata as any)?.cfg_scale || (a.metadata as any)?.cfgScale || (a.metadata as any)?.normalizedMetadata?.cfg_scale || 0;
        const bCfg = b.cfgScale || (b.metadata as any)?.cfg_scale || (b.metadata as any)?.cfgScale || (b.metadata as any)?.normalizedMetadata?.cfg_scale || 0;
        aValue = aCfg;
        bValue = bCfg;
        break;
      }
      case 'size':
      case 'megapixel': {
        // Both compare pixel area.
        const [aW, aH] = parseDimensions(a);
        const [bW, bH] = parseDimensions(b);
        aValue = aW * aH;
        bValue = bW * bH;
        break;
      }
      case 'aspect': {
        const [aW, aH] = parseDimensions(a);
        const [bW, bH] = parseDimensions(b);
        aValue = aW && aH ? aW / aH : 0;
        bValue = bW && bH ? bW / bH : 0;
        break;
      }
      case 'filesize':
        aValue = a.fileSize || 0;
        bValue = b.fileSize || 0;
        break;
      case 'seed': {
        const aSeed = a.seed || (a.metadata as any)?.seed || (a.metadata as any)?.normalizedMetadata?.seed || 0;
        const bSeed = b.seed || (b.metadata as any)?.seed || (b.metadata as any)?.normalizedMetadata?.seed || 0;
        aValue = aSeed;
        bValue = bSeed;
        break;
      }
      default:
        return 0;
    }

    if (typeof aValue === 'string' && typeof bValue === 'string') {
      return direction === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
    } else {
      return direction === 'asc' ? (aValue as number) - (bValue as number) : (bValue as number) - (aValue as number);
    }
  });
}
