import { useEffect, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Drawer } from "vaul";

/** True on screens at least `px` wide; follows the window as it resizes. */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/**
 * Extra detail that readers open only when they want it: a centred dialog on wide screens and a
 * drawer from the bottom on phones (the shadcn/ui "responsive dialog" pattern, on Radix Dialog
 * and Vaul). `trigger` must be a single focusable element, such as a button. Leave it out when
 * something else opens the panel, such as a row's action menu; then set `open` and `onOpenChange`.
 */
export function InfoPanel({
  trigger,
  title,
  description,
  children,
  open,
  onOpenChange,
}: {
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Set both to control it, e.g. so its own button can close it. Left out, it opens by itself. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const wide = useMediaQuery("(min-width: 768px)");
  const control = open === undefined ? {} : { open, onOpenChange };
  if (wide)
    return (
      <Dialog.Root {...control}>
        {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md [animation:fade_.25s_ease_both]" />
          <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[20px] border border-line-strong bg-surface shadow-(--shadow-raised) outline-none [animation:pop_.3s_cubic-bezier(0.19,1,0.22,1)_both]">
            <div className="flex items-start justify-between gap-4 p-7 pb-5">
              <div>
                <Dialog.Title className="text-[28px] leading-[1.02] font-medium tracking-[-0.045em]">
                  {title}
                </Dialog.Title>
                {description ? (
                  <Dialog.Description className="mt-1.5 text-sm text-muted">
                    {description}
                  </Dialog.Description>
                ) : (
                  <Dialog.Description className="sr-only">{title}</Dialog.Description>
                )}
              </div>
              <Dialog.Close
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)] transition hover:rotate-90 hover:bg-ink hover:text-paper hover:shadow-none"
                aria-label="Close"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="size-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </Dialog.Close>
            </div>
            <div className="overflow-y-auto px-7 pb-7">{children}</div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  return (
    <Drawer.Root {...control}>
      {trigger && <Drawer.Trigger asChild>{trigger}</Drawer.Trigger>}
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 flex max-h-[90vh] flex-col rounded-t-[26px] border-t border-line-strong bg-surface outline-none">
          <div className="mx-auto mt-3 h-1.5 w-12 shrink-0 rounded-full bg-white/20" aria-hidden />
          <div className="px-5 pt-4 pb-3">
            <Drawer.Title className="text-[28px] leading-[1.02] font-medium tracking-[-0.045em]">
              {title}
            </Drawer.Title>
            {description ? (
              <Drawer.Description className="mt-1.5 text-sm text-muted">
                {description}
              </Drawer.Description>
            ) : (
              <Drawer.Description className="sr-only">{title}</Drawer.Description>
            )}
          </div>
          <div className="overflow-y-auto px-5 pb-8">{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
