import { IndexedImage, ImageStack } from "../types";

export interface LayoutRow {
  items: (IndexedImage | ImageStack)[];
  height: number;
  width: number; // Actual width of content (might slightly vary from containerWidth due to rounding)
}

// Helper to get aspect ratio of an item
export const getItemAspectRatio = (item: IndexedImage | ImageStack): number => {
  // For stacks, use cover image
  const image = (item as ImageStack).coverImage || (item as IndexedImage);

  // Try to parse dimensions from metadata
  if (image.dimensions) {
    const [widthStr, heightStr] = image.dimensions.split("x");
    const w = parseInt(widthStr, 10);
    const h = parseInt(heightStr, 10);
    if (!isNaN(w) && !isNaN(h) && h > 0) {
      return w / h;
    }
  }

  // Fallback if metadata is missing or invalid
  const meta = image.metadata as any;
  if (meta.width && meta.height && meta.height > 0) {
    return meta.width / meta.height;
  }

  if (meta.normalizedMetadata?.width && meta.normalizedMetadata?.height && meta.normalizedMetadata.height > 0) {
    return meta.normalizedMetadata.width / meta.normalizedMetadata.height;
  }

  // Default fallback (square)
  return 1;
};

/**
 * Computes a justified layout for images, similar to Google Photos or Flickr.
 * Images are scaled to have the same height in a row, and the row height is adjusted
 * so that the row perfectly fills the container width.
 */
export const computeJustifiedLayout = (
  items: (IndexedImage | ImageStack)[],
  containerWidth: number,
  targetRowHeight: number,
  gap: number = 8,
): LayoutRow[] => {
  if (!items || items.length === 0 || containerWidth <= 0) {
    return [];
  }

  const rows: LayoutRow[] = [];
  let currentRowItems: (IndexedImage | ImageStack)[] = [];
  let currentAspectRatioSum = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const aspectRatio = getItemAspectRatio(item);
    
    currentAspectRatioSum += aspectRatio;
    currentRowItems.push(item);

    // Calculate potential height if we break here
    const totalGapWidth = (currentRowItems.length - 1) * gap;
    const availableWidth = containerWidth - totalGapWidth;
    
    // Height needed to fill container with current items
    // Width = Height * SumAspect
    // Height = Width / SumAspect
    const currentHeight = availableWidth / currentAspectRatioSum;

    // Check if we should break the row
    // We break if adding this item makes the row "full enough" or "too full"
    // Heuristic: Compare deviation from target height
    // If we are significantly smaller than target height, we definitely have too many items (or one very wide one)
    // If we are significantly larger than target height, we need more items
    
    if (currentHeight < targetRowHeight) {
        // We are strictly smaller than target (overfilled width).
        // Check if the previous state (without this item) was better?
        // But we can't easily go back unless we track "previous" state in loop.
        
        // Let's assume we want to decide whether to include this item or push it to next row.
        // Option 1: Include item. Row Height = currentHeight.
        // Option 2: Exclude item. Row ends at previous item.
        //    Previous Set Height = (Container - (N-2)*Gap) / (CurrentSum - Aspect)
        
        if (currentRowItems.length === 1) {
            // Must include at least one item
             rows.push({
                items: [...currentRowItems],
                height: currentHeight,
                width: containerWidth,
             });
             currentRowItems = [];
             currentAspectRatioSum = 0;
             continue;
        }

        const previousAspectRatioSum = currentAspectRatioSum - aspectRatio;
        const previousGapWidth = (currentRowItems.length - 2) * gap;
        const previousAvailableWidth = containerWidth - previousGapWidth;
        const previousHeight = previousAvailableWidth / previousAspectRatioSum;
        
        // Compare deviations
        const diffCurrent = Math.abs(currentHeight - targetRowHeight);
        const diffPrevious = Math.abs(previousHeight - targetRowHeight);
        
        if (diffPrevious < diffCurrent) {
             // Previous was better. Commit previous row.
             // Remove current item from this row and process it in next row (decrement i)
             currentRowItems.pop();
             rows.push({
                items: [...currentRowItems],
                height: previousHeight,
                width: containerWidth,
             });
             currentRowItems = [];
             currentAspectRatioSum = 0;
             i--; // Re-process this item
        } else {
            // Current is better (or close enough), but since we are < target, let's commit it?
            // Actually if we are < target, adding MORE items will make it even smaller.
            // So we MUST commit here.
            
             rows.push({
                items: [...currentRowItems],
                height: currentHeight,
                width: containerWidth,
             });
             currentRowItems = [];
             currentAspectRatioSum = 0;
        }
    }
  }

  // Handle last row
  if (currentRowItems.length > 0) {
    // For the last row, we define height as targetRowHeight
    // But we shouldn't stretch it to fill container if it's too empty.
    // Instead we just lay it out at targetRowHeight.
    rows.push({
      items: [...currentRowItems],
      height: targetRowHeight,
      width: containerWidth, // The container itself is full width, but items won't fill it
    });
  }

  return rows;
};
