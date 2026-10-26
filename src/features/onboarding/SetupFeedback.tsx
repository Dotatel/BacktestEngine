import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { OnboardingController } from "./useOnboarding";

/** Show recoverable runtime/save errors once; recovery screens contain their own storage message. */
export function SetupError({ setup }: { setup: OnboardingController }) {
  if (!setup.error || setup.store.loadState === "recovery") return null;
  const canRetry =
    setup.store.failure?.kind === "save" && !setup.agent.connecting;
  return (
    <div className="error-notice" role="alert">
      <TriangleAlert aria-hidden="true" />
      <div>
        <p>{setup.error}</p>
        {canRetry && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void setup.store.retry()}
          >
            Retry saving
          </Button>
        )}
      </div>
    </div>
  );
}

/** Confirm a backup/reset explicitly before the native storage operation can change setup. */
export function ResetSetupDialog({ setup }: { setup: OnboardingController }) {
  return (
    <Dialog open={setup.resetOpen} onOpenChange={setup.setResetOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset your setup?</DialogTitle>
          <DialogDescription>
            A backup of your previous settings will be kept on this device. Your
            projects and engine files will stay untouched.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setup.setResetOpen(false)}>
            Keep settings
          </Button>
          <Button
            onClick={() => void setup.reset()}
            disabled={setup.store.saving}
          >
            Back up and reset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
