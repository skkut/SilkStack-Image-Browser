import React from 'react';
import type { IndexedImage } from '../types';
import { safeLazy } from '../utils/safeLazy';
import { useAiFeaturesEnabled } from '../services/aiFeatureAccess';

const AddToAlbumDialogInner = import.meta.env.VITE_AI_FEATURES_AVAILABLE
  ? safeLazy(
      () => import('@ai-images-browser/ai-intelligence'),
      'AddToAlbumDialog',
      (mod) => (mod as any).AddToAlbumDialog,
    )
  : null;

export interface AddToAlbumDialogWrapperProps {
  /** The library selection to add. */
  images: IndexedImage[];
  onClose: () => void;
  onAdded?: (albumName: string, addedCount: number) => void;
}

/**
 * Host bridge for the module's "Add to album" dialog.
 *
 * The open tree contributes only the selected images; every album decision —
 * list, create, add — happens inside the premium module.
 */
const AddToAlbumDialogWrapper: React.FC<AddToAlbumDialogWrapperProps> = ({
  images,
  onClose,
  onAdded,
}) => {
  const aiFeaturesEnabled = useAiFeaturesEnabled();

  if (!aiFeaturesEnabled || !AddToAlbumDialogInner) {
    return null;
  }

  const Inner = AddToAlbumDialogInner;

  return (
    <Inner
      images={images as any}
      onClose={onClose}
      onAdded={onAdded}
    />
  );
};

export default AddToAlbumDialogWrapper;
