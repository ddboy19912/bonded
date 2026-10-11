import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NOTIFICATION_TYPES } from "@bondedhq/shared";
import { Link } from "react-router";
import { useAccount } from "wagmi";
import { ago } from "../lib/format";
import { inboxLines, inboxSeenAt, markInboxSeen, type InboxItem } from "../lib/health";
import { byoaApi } from "../lib/byoa-api";
import { messageCode } from "../lib/troubleshooting";
import { useOwnerSession } from "../lib/owner-session";
import { useInbox } from "../components/inbox-bell";
import { FixLink } from "../components/problem";
import { ConnectButton } from "../components/wallet";
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  Loading,
  Page,
  Unavailable,
  linkClass,
} from "../components/ui";

/** Which notifications the owner gets: each type can be turned off (webhook, email and this list). */
export function MuteSettings({ session }: { session: string }) {
  const settings = useQuery({
    queryKey: ["owner-notifications", session],
    queryFn: () => byoaApi.ownerNotifications(session),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!settings.data) return null;
  const types = settings.data.types ?? Object.keys(NOTIFICATION_TYPES);
  const muted = new Set(settings.data.muted ?? []);
  const toggle = async (type: string) => {
    const next = new Set(muted);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    setBusy(true);
    setError(null);
    try {
      await byoaApi.saveMuted(session, [...next]);
      await settings.refetch();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Choose what you're told about"
      description="A type you turn off isn't sent by webhook or email and doesn't show here."
    >
      <ul className="flex flex-col divide-y divide-line text-sm">
        {types.map((t) => (
          <li key={t}>
            <label className="flex cursor-pointer items-start gap-3 py-2.5 first:pt-0 last:pb-0">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-brand-bright"
                checked={!muted.has(t)}
                disabled={busy}
                onChange={() => void toggle(t)}
              />
              <span className={muted.has(t) ? "text-muted" : ""}>
                {NOTIFICATION_TYPES[t as keyof typeof NOTIFICATION_TYPES] ?? t}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <ErrorText error={error} />
    </Card>
  );
}

/** The owner's notifications: score expiring, runner offline, breaches, claims, cover, gas. */
export function Inbox() {
  const { isConnected } = useAccount();
  const owner = useOwnerSession();
  const inbox = useInbox(owner.session?.session);
  const queryClient = useQueryClient();
  // What was new when the page opened stays marked new until the next visit. Only what the page
  // shows is marked read (on the API, so other browsers agree): older notifications, on pages not
  // loaded yet, stay unread until "Load more" shows them.
  const [seenBefore] = useState(() => inboxSeenAt());
  const marked = useRef(new Set<string>());
  const session = owner.session?.session;
  // Older pages, loaded with "Load more" from the `next` cursor.
  const [older, setOlder] = useState<{ items: InboxItem[]; next: string | null }>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const firstPage = inbox.data?.items ?? [];
  const firstIds = new Set(firstPage.map((i) => i.id));
  const items = [...firstPage, ...(older?.items ?? []).filter((i) => !firstIds.has(i.id))];
  const next = older ? older.next : (inbox.data?.next ?? null);
  const unreadShown = items
    .filter((i) => i.read === false && !marked.current.has(i.id))
    .map((i) => i.id);
  const unreadKey = unreadShown.join(",");
  useEffect(() => {
    if (!inbox.data) return;
    markInboxSeen();
    if (!session || !unreadShown.length) return;
    const ids = unreadShown;
    for (const id of ids) marked.current.add(id);
    void byoaApi
      .markInboxRead(session, { ids })
      .then(() =>
        queryClient.invalidateQueries({ queryKey: ["inbox", session], refetchType: "none" }),
      )
      .catch(() => {
        // Not marked: the items stay unread, which is harmless, and are tried again.
        for (const id of ids) marked.current.delete(id);
      });
    // Keyed on the unread ids shown, so each newly shown one is marked once.
  }, [inbox.data, session, queryClient, unreadKey]);
  const loadMore = async () => {
    if (!session || !next) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await byoaApi.inbox(session, { before: next });
      setOlder((o) => ({ items: [...(o?.items ?? []), ...page.items], next: page.next ?? null }));
    } catch (e) {
      setMoreError(e);
    } finally {
      setLoadingMore(false);
    }
  };
  const list = (
    <Card>
      <ul className="flex flex-col" aria-label="Notifications">
        {items.map((i) => {
          const fresh = i.read !== undefined ? !i.read : Date.parse(i.createdAt) > seenBefore;
          const { title, detail } = inboxLines(i);
          return (
            <li
              key={i.id}
              className="grid grid-cols-[0.5rem_minmax(0,1fr)_auto] gap-x-3 border-t border-line py-4 text-sm first:border-0 first:pt-0 last:pb-0"
            >
              <span
                className={`mt-[7px] size-2 rounded-full ${fresh ? "bg-accent" : ""}`}
                {...(fresh ? { "aria-label": "New" } : { "aria-hidden": true })}
              />
              <div className="flex min-w-0 flex-col gap-1">
                <p className={fresh ? "font-semibold" : "font-medium"}>{title}</p>
                {detail && <p className="text-soft">{detail}</p>}
                {(i.agentId || i.code) && (
                  <p className="flex flex-wrap gap-x-3 pt-0.5 text-xs">
                    {i.agentId && (
                      <Link className={linkClass} to={`/agents/${i.agentId}`}>
                        Agent {i.agentId}
                      </Link>
                    )}
                    <FixLink code={messageCode({ code: i.code ?? null, message: i.message })} />
                  </p>
                )}
              </div>
              <time dateTime={i.createdAt} className="pt-0.5 text-xs whitespace-nowrap text-muted">
                {ago(i.createdAt)}
              </time>
            </li>
          );
        })}
      </ul>
      {next && (
        <div className="mt-4 flex flex-col items-center gap-2 border-t border-line pt-4">
          <Button size="sm" kind="secondary" loading={loadingMore} onClick={() => void loadMore()}>
            Load more
          </Button>
          <ErrorText error={moreError} />
        </div>
      )}
    </Card>
  );
  return (
    <Page
      title="Notifications"
      intro="What needs you about your agents. The same notices go to your webhook or email if you set one on an agent's page."
    >
      {!isConnected ? (
        <EmptyState title="Connect your wallet" action={<ConnectButton />}>
          Notifications are for the agents your wallet owns.
        </EmptyState>
      ) : !owner.session ? (
        <EmptyState
          title="Sign in to see them"
          action={
            <div className="flex flex-col items-center gap-2">
              <Button loading={owner.signingIn} onClick={() => void owner.signIn()}>
                {owner.signingIn ? "Sign in your wallet…" : "Sign in"}
              </Button>
              <ErrorText error={owner.error} />
            </div>
          }
        >
          One signature, no gas.
        </EmptyState>
      ) : inbox.isPending ? (
        <Card>
          <Loading what="your notifications" />
        </Card>
      ) : inbox.error ? (
        <Unavailable error={inbox.error} onRetry={() => void inbox.refetch()} />
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          {!inbox.data?.items.length ? (
            <EmptyState title="Nothing yet">
              When something needs you (a score about to expire, the runner offline, a breach or a
              claim, cover lapsing, low gas), it shows here.
            </EmptyState>
          ) : (
            list
          )}
          <div className="lg:sticky lg:top-24">
            <MuteSettings session={owner.session.session} />
          </div>
        </div>
      )}
    </Page>
  );
}
