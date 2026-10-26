import type { Ref } from "react";
import {
  ArrowRight,
  CircleCheck,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { Brand } from "@/components/Brand";
import { Button } from "@/components/ui/button";
import { SetupSummary } from "./SetupSummary";
import type { OnboardingController } from "./useOnboarding";

interface ScreenProps {
  setup: OnboardingController;
  headingRef: Ref<HTMLHeadingElement>;
}

/** Give startup a stable accessible status while the host reads settings. */
export function LoadingSetup() {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle className="spinner" aria-hidden="true" />
      <p>Opening your setup…</p>
    </div>
  );
}

/** Present compact Welcome and expand only after the user's progress is saved. */
export function WelcomeSetup({ setup, headingRef }: ScreenProps) {
  return (
    <section className="welcome">
      <Brand />
      <h1 ref={headingRef} tabIndex={-1}>
        Welcome to BacktestEngine
      </h1>
      <Button
        size="lg"
        className="primary-action"
        disabled={setup.busy}
        onClick={() => void setup.navigate(2)}
      >
        Get Started
        <ArrowRight aria-hidden="true" />
      </Button>
      <p className="welcome-progress" aria-label="Step 1 of 5">
        01 / 05
      </p>
    </section>
  );
}

/** Keep damaged settings intact while offering retry or a separately confirmed backup/reset. */
export function RecoverSetup({ setup, headingRef }: ScreenProps) {
  return (
    <section className="recovery">
      <TriangleAlert aria-hidden="true" />
      <h1 ref={headingRef} tabIndex={-1}>
        Let’s recover your setup
      </h1>
      <p>Your project files are safe.</p>
      <p className="recovery-error" role="alert">
        {setup.error}
      </p>
      <div className="recovery-actions">
        <Button
          onClick={() => void setup.reload()}
          disabled={setup.store.saving}
        >
          Retry
        </Button>
        <Button
          variant="outline"
          onClick={() => setup.setResetOpen(true)}
          disabled={setup.store.saving}
        >
          Reset setup
        </Button>
      </div>
    </section>
  );
}

/** Summarize actual choices before the final durable commit; no project or agent task is created. */
export function FinishSetup({ setup, headingRef }: ScreenProps) {
  return (
    <section className="setup-content step-5" aria-labelledby="step-heading">
      <p className="finish-progress" aria-label="Step 5 of 5">
        05 / 05
      </p>
      <CircleCheck className="finish-icon" aria-hidden="true" />
      <h1 id="step-heading" ref={headingRef} tabIndex={-1}>
        You’re all set
      </h1>
      <p className="step-description">Your setup is ready.</p>
      <SetupSummary preferences={setup.store.preferences} />
      <Button
        size="lg"
        className="primary-action finish-action"
        disabled={setup.busy}
        onClick={() => void setup.finish()}
      >
        Open BacktestEngine
        <ArrowRight aria-hidden="true" />
      </Button>
    </section>
  );
}
