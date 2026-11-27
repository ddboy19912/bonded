import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { byoaApi } from "../lib/byoa-api";
import { unreadCount } from "../lib/health";
import { useOwnerSession } from "../lib/owner-session";

/** The owner's in-app notifications, as a bell in the top bar. Only once signed in. */
export function useInbox(session: string | undefined) {
  return useQuery({
    queryKey: ["inbox", session],
    queryFn: () => byoaApi.inbox(session!),
    enabled: Boolean(session),
    refetchInterval: 60_000,
    retry: false,
  });
}

export function InboxBell() {
  const owner = useOwnerSession();
  const inbox = useInbox(owner.session?.session);
  if (!owner.session || !inbox.data) return null;
  const unread = unreadCount(inbox.data);
  return (
    <Link
      to="/inbox"
      className="relative inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted shadow-[inset_0_0_0_1px_rgb(255_255_255/0.2)] transition-colors hover:text-ink hover:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.4)]"
      aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
    >
      <svg
        viewBox="0 0 24 24"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {unread > 0 && (
        <span className="absolute -top-1 -right-1 min-w-5 rounded-full bg-breach-solid px-1 text-center font-mono text-[11px] leading-5 font-medium text-black">
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </Link>
  );
}
