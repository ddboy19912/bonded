import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NOTIFICATION_TYPES } from "@bondedhq/shared";
import { Link } from "react-router";
import { ago } from "../lib/format";
import { inboxLines, inboxSeenAt, markInboxSeen, type InboxItem } from "../lib/health";
import { byoaApi } from "../lib/byoa-api";
import { messageCode } from "../lib/troubleshooting";
import { dayGroups, noticeKind, settingGroups } from "../lib/notification-kinds";
import { useOwnerSession } from "../lib/owner-session";
import { useInbox } from "../components/inbox-bell";
import { InfoPanel } from "../components/overlay";
import { NoticeIcon } from "../components/notice-icon";
import type { NoticeIconName, NoticeTone } from "../lib/notification-kinds";
import { FixLink } from "../components/problem";
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Loading,
  Page,
  Section,
  Skeleton,
  Switch,
  Unavailable,
  buttonClass,
  linkClass,
} from "../components/ui";
import { SignInButton } from "../components/sign-in";

/** What shows here, for someone who hasn't signed in: the empty state's list, as icons. */
const KINDS: { icon: NoticeIconName; tone: NoticeTone; text: string }[] = [
  { icon: "clock", tone: "warn", text: "A score about to expire" },
  { icon: "plug", tone: "warn", text: "The runner offline" },
  { icon: "shield", tone: "breach", text: "A breach or a claim" },
  { icon: "umbrella", tone: "warn", text: "Cover lapsing" },
  { icon: "fuel", tone: "warn", text: "Low gas" },
];

/** Which notifications the owner gets: each type can be turned off (webhook, email and this list). */
export function MuteSettings({ session }: { session: string }) {
  const settings = useQuery({
    queryKey: ["owner-notifications", session],
    queryFn: () => byoaApi.ownerNotifications(session),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (settings.error) return <ErrorText error={settings.error} />;
  if (!settings.data)
    return (
      <div className="flex flex-col gap-4" aria-label="Loading your settings">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
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
    <div className="flex flex-col gap-6">
      {settingGroups(types).map((g) => (
        <section key={g.group} aria-label={g.group}>
          <h3 className="eyebrow">{g.group}</h3>
          <div className="mt-1 divide-y divide-line">
            {g.items.map((i) => (
              <Switch
                key={i.type}
                label={i.title}
                description={i.description}
                checked={!muted.has(i.type)}
                disabled={busy}
                onChange={() => void toggle(i.type)}
              />
            ))}
          </div>
        </section>
      ))}
      <ErrorText error={error} />
    </div>
  );
}

/** The owner's notifications: score expiring, runner offline, breaches, claims, cover, gas. */
export function Inbox() {
  const owner = useOwnerSession();
  const inbox = useInbox(owner.session?.session);
  const queryClient = useQueryClient();
  // What was new when the page opened stays marked new until the next visit. Only what the page
  // shows is marked read (on the API, so other browsers agree): older notifications, on pages not
  // loaded yet, stay unread until "Load more" shows them.
  const [seenBefore] = useState(() => inboxSeenAt());
  const marked = useRef(new Set<string>());
  const session = owner.session?.session;
  // Older pages, loaded with "Load more" from the `next` cursor. Kept with the session they were
  // loaded for, so after a sign-out and another account's sign-in none of them show.
  const [loaded, setOlder] = useState<{
    session: string;
    items: InboxItem[];
    next: string | null;
  }>();
  const older = loaded && loaded.session === session ? loaded : undefined;
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
      // Refetched now so the bell's count drops; `marked` keeps these showing as new on this page.
      .then(() => queryClient.invalidateQueries({ queryKey: ["inbox", session] }))
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
      // A page that comes back after the session changed belongs to nobody on screen now.
      setOlder((o) => ({
        session,
        items: [...(o?.session === session ? o.items : []), ...page.items],
        next: page.next ?? null,
      }));
    } catch (e) {
      setMoreError(e);
    } finally {
      setLoadingMore(false);
    }
  };
  const now = Date.now();
  const fresh = (i: InboxItem) =>
    i.read !== undefined
      ? !i.read || marked.current.has(i.id)
      : Date.parse(i.createdAt) > seenBefore;
  const freshCount = items.filter(fresh).length;
  const feed = (
    <div className="flex flex-col">
      <p className="h-section mb-10 text-muted sm:mb-14" aria-live="polite">
        {freshCount > 0 ? (
          <>
            <span className="text-accent">{freshCount} new</span> since you last looked
          </>
        ) : (
          "You're all caught up."
        )}
      </p>
      {dayGroups(items, now).map((g) => (
        <section key={g.label} aria-label={g.label} className="app-sec pb-4">
          <h2 className="eyebrow app-sec-lab">{g.label}</h2>
          <ul
            className="flex min-w-0 flex-col divide-y divide-line"
            aria-label={`Notifications, ${g.label.toLowerCase()}`}
          >
            {g.items.map((i) => {
              const isNew = fresh(i);
              const kind = noticeKind(i);
              const { title, detail } = inboxLines(i);
              return (
                <li key={i.id} className="flex gap-4 py-5 text-sm first:pt-0">
                  <span className="relative">
                    <NoticeIcon icon={kind?.icon} tone={kind?.tone} />
                    {isNew && (
                      <span
                        className="absolute -top-0.5 -right-0.5 size-3 rounded-full border-2 border-paper bg-accent"
                        aria-hidden
                      />
                    )}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {kind && <span className="eyebrow">{kind.title}</span>}
                      {isNew && <Badge tone="brand">New</Badge>}
                    </div>
                    <p
                      className={`text-[17px] leading-snug tracking-[-0.01em] ${isNew ? "font-semibold" : "font-medium"}`}
                    >
                      {title}
                    </p>
                    {detail && <p className="text-soft">{detail}</p>}
                    {(i.agentId || i.code) && (
                      <p className="flex flex-wrap gap-x-4 pt-0.5">
                        {i.agentId && (
                          <Link className={linkClass} to={`/agents/${i.agentId}`}>
                            Agent {i.agentId}
                          </Link>
                        )}
                        <FixLink code={messageCode({ code: i.code ?? null, message: i.message })} />
                      </p>
                    )}
                  </div>
                  <time
                    dateTime={i.createdAt}
                    className="shrink-0 pt-0.5 text-xs whitespace-nowrap text-muted"
                  >
                    {ago(i.createdAt)}
                  </time>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {next && (
        <div className="flex flex-col items-start gap-2 pt-8 lg:pl-[calc(9.5rem+32px)]">
          <Button size="sm" kind="secondary" loading={loadingMore} onClick={() => void loadMore()}>
            Load more
          </Button>
          <ErrorText error={moreError} />
        </div>
      )}
    </div>
  );
  return (
    <Page
      title="Notifications"
      intro="What needs you about your agents. The same notices go to your webhook or email if you set one on an agent's page."
      actions={
        owner.session && (
          <InfoPanel
            trigger={
              <button type="button" className={buttonClass("secondary")}>
                Settings
              </button>
            }
            title="Notification settings"
            description="A type you turn off isn't sent by webhook or email and doesn't show here."
          >
            <MuteSettings session={owner.session.session} />
          </InfoPanel>
        )
      }
    >
      {!owner.session ? (
        <Section
          label="Your inbox"
          title="Sign in to see them"
          intro="Notifications are for your agents and previews."
        >
          <SignInButton
            size="lg"
            wallet={{
              signIn: () => void owner.signIn(),
              signingIn: owner.signingIn,
              error: owner.error,
            }}
          />
          <div className="mt-14 border-t border-line pt-5">
            <p className="eyebrow">What shows here</p>
            <ul className="mt-5 grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
              {KINDS.map((k) => (
                <li key={k.text} className="flex items-center gap-3.5 text-[15px] text-soft">
                  <NoticeIcon icon={k.icon} tone={k.tone} />
                  {k.text}
                </li>
              ))}
            </ul>
          </div>
        </Section>
      ) : inbox.isPending ? (
        <Loading what="your notifications" height="md" />
      ) : inbox.error ? (
        <Unavailable error={inbox.error} onRetry={() => void inbox.refetch()} />
      ) : !inbox.data?.items.length ? (
        <EmptyState title="Nothing yet">
          When something needs you (a score about to expire, the runner offline, a breach or a
          claim, cover lapsing, low gas), it shows here.
        </EmptyState>
      ) : (
        feed
      )}
    </Page>
  );
}
