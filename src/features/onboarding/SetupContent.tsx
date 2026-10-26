import type { Ref } from "react";
import { ChoiceStep } from "./ChoiceStep";
import {
  FinishSetup,
  LoadingSetup,
  RecoverSetup,
  WelcomeSetup,
} from "./SetupStates";
import type { OnboardingController } from "./useOnboarding";

/** Route setup states with explicit guards; each screen owns only presentation. */
export function SetupContent({
  setup,
  headingRef,
}: {
  setup: OnboardingController;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  if (setup.store.loadState === "loading") return <LoadingSetup />;
  if (setup.store.loadState === "recovery")
    return <RecoverSetup setup={setup} headingRef={headingRef} />;
  if (setup.store.preferences.step === 1)
    return <WelcomeSetup setup={setup} headingRef={headingRef} />;
  if (setup.store.preferences.step === 5)
    return <FinishSetup setup={setup} headingRef={headingRef} />;
  return <ChoiceStep setup={setup} headingRef={headingRef} />;
}
