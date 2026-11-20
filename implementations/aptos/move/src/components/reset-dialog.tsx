import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";

/** Reset Demo and its confirmation. The trigger receives focus when it closes. */
export function ResetDialog({
  disabled,
  onReset,
}: {
  disabled: boolean;
  onReset: () => void;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="link" size="sm" className="px-0" disabled={disabled}>
          Reset Demo
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start fresh?</DialogTitle>
          <DialogDescription>
            This removes access to your disposable wallet from this browser.
            On-chain records remain. Pending transactions may still complete.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Keep demo</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button onClick={onReset}>Reset and remove wallet</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
