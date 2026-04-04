import { useMemo } from "react";

export type ProFeature =
  | "a1111"
  | "comfyui"
  | "clustering"
  | "batch_export";

export const CLUSTERING_FREE_TIER_LIMIT = Infinity;
export const CLUSTERING_PREVIEW_LIMIT = Infinity;

/**
 * useFeatureAccess hook
 * Simplified version: all features are unlocked by default.
 */
export const useFeatureAccess = () => {
  // All features are unlocked in this version
  const isPro = true;

  // Feature flags
  const canUseA1111 = true;
  const canUseComfyUI = true;
  const canUseBatchExport = true;

  return {
    // Feature flags
    canUseA1111,
    canUseComfyUI,
    canUseBatchExport,

    // Clustering limits
    canUseFullClustering: true,
    canUseDuringTrialOrPro: true,
    clusteringImageLimit: Infinity,

    // Status (mocked as Pro)
    isTrialActive: false,
    isExpired: false,
    isFree: false,
    isPro: true,
    canStartTrial: false,
    trialUsed: false,
    licenseStatus: "pro",
    initialized: true,
    statusLabel: "",

    // Trial info (unused)
    trialDaysRemaining: 0,
    startTrial: () => {},

    // Modal control (no-ops)
    proModalOpen: false,
    proModalFeature: "a1111" as ProFeature,
    showProModal: (feature: ProFeature) => {
      console.log("Pro feature used:", feature);
    },
    closeProModal: () => {},
  };
};
