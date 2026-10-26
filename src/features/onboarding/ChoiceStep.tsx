import type { Ref } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChoiceGroup } from "@/components/ChoiceGroup";
import { AgentActions } from "./AgentActions";
import {
  workspaceChoices,
  appearanceChoices,
  agentChoices,
  stepCopy,
} from "./choices";
import type { OnboardingController } from "./useOnboarding";

/** Select a typed choice group without unchecked casts across the primitive boundary. */
function StepChoices({ setup }: { setup: OnboardingController }) {
  const preferences = setup.store.preferences;
  if (preferences.step === 2)
    return (
      <ChoiceGroup
        label="Workspace style"
        value={preferences.workspaceStyle}
        choices={workspaceChoices}
        onChange={(workspaceStyle) => setup.choose({ workspaceStyle })}
      />
    );
  if (preferences.step === 3)
    return (
      <ChoiceGroup
        label="Appearance"
        value={preferences.appearance}
        choices={appearanceChoices}
        kind="appearance"
        onChange={(appearance) => setup.choose({ appearance })}
      />
    );
  return (
    <ChoiceGroup
      label="AI agent"
      value={preferences.agent ?? ""}
      choices={agentChoices}
      kind="agent"
      disabled={setup.agent.connecting}
      onChange={(agent) => setup.choose({ agent, agentVerified: false })}
    />
  );
}

/** Render one selection task with shared composition and standard component size APIs. */
export function ChoiceStep({
  setup,
  headingRef,
}: {
  setup: OnboardingController;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const step = setup.store.preferences.step;
  const copy = stepCopy[step];
  return (
    <section
      className={`setup-content step-${step}`}
      aria-labelledby="step-heading"
    >
      <p className="step-progress" aria-label={`Step ${step} of 5`}>
        0{step} / 05
      </p>
      <h1 id="step-heading" ref={headingRef} tabIndex={-1}>
        {copy.title}
      </h1>
      <p className="step-description">{copy.description}</p>
      <StepChoices setup={setup} />
      <div className="step-actions">
        {step === 4 && <AgentActions setup={setup} />}
        {step !== 4 && (
          <Button
            size="lg"
            className="primary-action"
            disabled={setup.busy}
            onClick={() => void setup.navigate(step + 1)}
          >
            Continue
            <ArrowRight aria-hidden="true" />
          </Button>
        )}
      </div>
    </section>
  );
}
