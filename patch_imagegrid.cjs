const fs = require('fs');
const path = 'c:/Projects/AI-Images-Browser/components/ImageGrid.tsx';

try {
  const data = fs.readFileSync(path, 'utf8');
  const lines = data.split('\n');
  
  // 1-based 1496 to 1528
  // 0-based 1495 to 1527
  const startIdx = 1495;
  const endIdx = 1527;
  
  console.log('Line 1496:', lines[startIdx]);
  console.log('Line 1528:', lines[endIdx]);
  
  if (!lines[startIdx].includes('const image = item;')) {
    console.error('Start line mismatch: ' + lines[startIdx]);
    process.exit(1);
  }
  // line 1528 might be indented
  if (!lines[endIdx].trim().endsWith(');')) {
     console.error('End line mismatch: ' + lines[endIdx]);
     process.exit(1);
  }
  
  const newContent = `                         return (
                            <div key={image.id} style={{ width, height: row.height, flexShrink: 0 }}>
                                <ImageCard
                                    image={image}
                                    onImageClick={onImageClick}
                                    isSelected={selectedImages.has(image.id)}
                                    // Calculate isFocused logic here or ignore for simple pagination view?
                                    // Simple view focus is handled by ImageCard but we need to track index.
                                    // Just ignore focus rect for now or pass focused === index.
                                    isFocused={false} 
                                    onImageLoad={handleImageLoad}
                                    onContextMenu={(img, e) => handleContextMenu(img, e)}
                                    baseWidth={width}
                                    isComparisonFirst={comparisonFirstImage?.id === image.id}
                                    cardRef={createCardRef(image.id)}
                                    isMarkedBest={markedBestIds?.has(image.id)}
                                    isMarkedArchived={markedArchivedIds?.has(image.id)}
                                    isBlurred={isSensitive && enableSafeMode && blurSensitiveImages}
                                    getDragPayload={getDragPayload}
                                />
                            </div>
                         );`;
                         
  // Replace lines
  lines.splice(startIdx, endIdx - startIdx + 1, newContent);
  
  fs.writeFileSync(path, lines.join('\n'), 'utf8');
  console.log('Successfully patched!');
  
} catch (err) {
  console.error(err);
  process.exit(1);
}
