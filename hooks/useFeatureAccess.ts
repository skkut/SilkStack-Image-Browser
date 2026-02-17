import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { useLicenseStore, TRIAL_DURATION_DAYS } from "../store/useLicenseStore";

export type ProFeature =
  | "a1111"
  | "comfyui"
  | "comparison"
  | "analytics"
  | "clustering"
  | "batch_export";

export const CLUSTERING_FREE_TIER_LIMIT = 300;
export const CLUSTERING_PREVIEW_LIMIT = 500; // Process extra for blurred preview

type ProModalState = {
  proModalOpen: boolean;
  proModalFeature: ProFeature;
  openProModal: (feature: ProFeature) => void;
  closeProModal: () => void;
};

export const useProModalStore = create<ProModalState>((set) => ({
  proModalOpen: false,
  proModalFeature: "a1111",
  openProModal: (feature) =>
    set({ proModalOpen: true, proModalFeature: feature }),
  closeProModal: () => set({ proModalOpen: false }),
}));

// Helper: Check if trial has expired
const isTrialExpired = (trialStartDate: number | null): boolean => {
  if (!trialStartDate) return false;

  const now = Date.now();
  const trialEnd = trialStartDate + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000;

  // Clock rollback or expired
  return now < trialStartDate || now > trialEnd;
};

// Helper: Calculate days remaining in trial
const calculateDaysRemaining = (trialStartDate: number | null): number => {
  if (!trialStartDate) return 0;

  const now = Date.now();
  const trialEnd = trialStartDate + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000;
  const msRemaining = trialEnd - now;

  return Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));
};

export const useFeatureAccess = () => {
  const licenseStore = useLicenseStore();
  const proModalOpen = useProModalStore((state) => state.proModalOpen);
  const proModalFeature = useProModalStore((state) => state.proModalFeature);
  const openProModal = useProModalStore((state) => state.openProModal);
  const closeProModal = useProModalStore((state) => state.closeProModal);

  // Dev override: localStorage flag to bypass all checks
  // Force Pro features for this custom browser
  const isPro = true;

  const isTrialActive = false;
  const isExpired = false;
  const isFree = false;
  const trialUsed = false;
  const canStartTrial = false;

  // During initialization, keep features open to avoid flicker
  const allowDuringInit = true; // Always allow
  const canUseDuringTrialOrPro = true; // Always allow

  // Feature flags (all Pro features have same access requirements)
  const canUseA1111 = true;
  const canUseComfyUI = true;
  const canUseComparison = true;
  const canUseAnalytics = true;
  const canUseBatchExport = true;

  // Trial countdown
  const trialDaysRemaining = 0;

  // Modal control
  const showProModal = (feature: ProFeature) => {
    // No-op: Pro modal should never be shown
    console.log("Pro modal suppressed", feature);
  };

  // Optional derived label for status indicators
  const statusLabel = useMemo(() => {
    return ""; // No status label needed for fully unlocked version
  }, []);

  const startTrial = () => {
    // No-op
  };

  // Log dev override
  useEffect(() => {
    // console.log('🔓 [IMH] Custom Browser: All features unlocked');
  }, []);

  return {
    // Feature flags
    canUseA1111,
    canUseComfyUI,
    canUseComparison,
    canUseAnalytics,
    canUseBatchExport,

    // Clustering limits
    canUseFullClustering: true,
    canUseDuringTrialOrPro: true,
    clusteringImageLimit: Infinity,

    // Status
    isTrialActive,
    isExpired,
    isFree,
    isPro,
    canStartTrial,
    trialUsed,
    licenseStatus: "pro",
    initialized: true,
    statusLabel,

    // Trial info
    trialDaysRemaining,
    startTrial,

    // Modal control
    proModalOpen,
    proModalFeature,
    showProModal, // Kept to satisfy interface but wont do anything useful
    closeProModal,
  };
};
