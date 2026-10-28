import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import type { useAppSettings } from "./useAppSettings";
/** Protect corruption recovery with a separate explicit confirmation and a retained backup. */
export function RecoveryAction({
  controller,
  disabled,
}: {
  controller: ReturnType<typeof useAppSettings>;
  disabled: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          Back up and reset app settings
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Back up and reset application settings?
          </AlertDialogTitle>
          <AlertDialogDescription>
            A backup preserves the damaged document before resetting
            report-folder, update and extension-enable choices. Onboarding
            preferences and project files remain available.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void controller.recover()}>
            Back up and reset
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
