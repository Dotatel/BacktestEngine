import { ArrowRight, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { providerNames } from "@/lib/preferences";
import type { OnboardingController } from "./useOnboarding";

/** Choose the provider action using explicit states; operations remain outside the presentation component. */
function ConnectionButton({ setup }: { setup: OnboardingController }) {
  if (setup.agent.connecting)
    return (
      <Button
        variant="outline"
        size="lg"
        className="primary-action"
        onClick={() => void setup.agent.cancel()}
      >
        <LoaderCircle className="spinner" aria-hidden="true" />
        Cancel connection
      </Button>
    );
  if (setup.store.preferences.agentVerified)
    return (
      <Button
        size="lg"
        className="primary-action"
        disabled={setup.store.saving}
        onClick={() => void setup.navigate(5)}
      >
        Continue
        <ArrowRight aria-hidden="true" />
      </Button>
    );
  return (
    <Button
      size="lg"
      className="primary-action"
      disabled={!setup.store.preferences.agent || setup.store.saving}
      onClick={() => void setup.connect()}
    >
      Connect agent
      <ArrowRight aria-hidden="true" />
    </Button>
  );
}

/** Present provider feedback and a skip path without claiming connectivity from selection alone. */
export function AgentActions({ setup }: { setup: OnboardingController }) {
  const preferences = setup.store.preferences;
  let message = "No account is needed to use BacktestEngine.";
  if (preferences.agent && preferences.agentVerified)
    message = `${providerNames[preferences.agent]} connection verified for this session.`;
  if (setup.agent.message) message = setup.agent.message;
  return (
    <>
      <p className="connection-note" role="status">
        {message}
      </p>
      <ConnectionButton setup={setup} />
      <Button
        variant="ghost"
        className="skip-action"
        disabled={setup.store.saving}
        onClick={() => void setup.skipAgent()}
      >
        Skip for now
      </Button>
    </>
  );
}
