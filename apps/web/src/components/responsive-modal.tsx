import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/shadcn/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/shadcn/drawer";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "./overlay";

/**
 * A modal on wide screens and a drawer from the bottom on phones (shadcn/ui's responsive dialog).
 * `locked` keeps it open until something in it closes it: for a secret that's shown once, or a
 * change that's still running.
 */
export function ResponsiveModal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
  locked = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Room for a table; "full" for code, up to the width of the window. */
  wide?: boolean | "full";
  locked?: boolean;
}) {
  const desktop = useMediaQuery("(min-width: 768px)");
  if (desktop)
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={!locked}
          className={cn(
            "flex max-h-[85vh] flex-col gap-0 p-0",
            wide === "full"
              ? "sm:max-w-[min(72rem,calc(100vw-4rem))]"
              : wide
                ? "sm:max-w-2xl"
                : "sm:max-w-lg",
          )}
          {...(locked
            ? {
                onEscapeKeyDown: (e) => e.preventDefault(),
                onInteractOutside: (e) => e.preventDefault(),
              }
            : {})}
        >
          <DialogHeader className="gap-1.5 p-6 pb-4 pr-12 text-left">
            <DialogTitle className="text-xl leading-snug font-semibold">{title}</DialogTitle>
            <DialogDescription className={description ? "" : "sr-only"}>
              {description ?? title}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto px-6 pb-6">{children}</div>
        </DialogContent>
      </Dialog>
    );
  return (
    <Drawer open={open} onOpenChange={onOpenChange} dismissible={!locked}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="text-xl leading-snug">{title}</DrawerTitle>
          <DrawerDescription className={description ? "" : "sr-only"}>
            {description ?? title}
          </DrawerDescription>
        </DrawerHeader>
        <div className="min-h-0 overflow-y-auto px-5 pb-8">{children}</div>
      </DrawerContent>
    </Drawer>
  );
}

/** A modal's buttons: at its foot on the right, or stacked full width on phones. */
export function ModalActions({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{children}</div>
  );
}
