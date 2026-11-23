// Three onboarding/connection/empty-flow variants (A Relay Ledger, B Quiet Threshold, C Operator Bench), switchable via ?variant= on the existing app route.
import { useEffect } from "react";
import { useOnboarding, OnboardingProvider } from "./OnboardingContext";
import { variantKeys } from "./model";
import { PrototypeToast, RepairResultSheet } from "./parts";
import { VariantA } from "./VariantA";
import { VariantB } from "./VariantB";
import { VariantC } from "./VariantC";
import "./onboarding.css";

function PrototypeSurface() {
  const { variant, setVariant, repairResult, closeRepairResult } = useOnboarding();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = Boolean(
        target?.closest("input, textarea, select, [contenteditable='true']"),
      );
      if (event.key === "Escape" && repairResult) {
        closeRepairResult();
        return;
      }
      if (editing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const index = variantKeys.indexOf(variant);
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const next = variantKeys[(index + direction + variantKeys.length) % variantKeys.length];
      setVariant(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [variant, setVariant, repairResult, closeRepairResult]);

  return (
    <>
      {variant === "A" && <VariantA />}
      {variant === "B" && <VariantB />}
      {variant === "C" && <VariantC />}
      <RepairResultSheet />
      <PrototypeToast />
    </>
  );
}

export function OnboardingPrototype() {
  return (
    <OnboardingProvider>
      <PrototypeSurface />
    </OnboardingProvider>
  );
}
