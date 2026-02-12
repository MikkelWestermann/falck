import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface UnsavedChangesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: () => void;
  onDiscard: () => void;
  targetLabel?: string;
  saveDisabled?: boolean;
  saveDisabledReason?: string;
}

export function UnsavedChangesDialog({
  open,
  onOpenChange,
  onSave,
  onDiscard,
  targetLabel,
  saveDisabled = false,
  saveDisabledReason,
}: UnsavedChangesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Unsaved changes</DialogTitle>
          <DialogDescription>
            {targetLabel
              ? `You're about to ${targetLabel}. `
              : "You're about to switch projects. "}
            Save your changes or discard them before continuing. Discarding will
            delete them.
          </DialogDescription>
        </DialogHeader>

        {saveDisabled && saveDisabledReason && (
          <Alert variant="destructive">
            <AlertDescription>{saveDisabledReason}</AlertDescription>
          </Alert>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onDiscard}>
            Discard changes
          </Button>
          <Button onClick={onSave} disabled={saveDisabled}>
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
