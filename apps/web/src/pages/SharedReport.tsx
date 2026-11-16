import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { byoaApi } from "../lib/byoa-api";
import { usePageTitle } from "../lib/page-title";
import { TEST_AGENT } from "../lib/routes";
import { BrokerageFindingsReport, brokerageReportOf } from "../components/brokerage-findings";
import { PreviewReport } from "../components/preview-report";
import { EmptyState, Loading, Page, Unavailable, buttonClass } from "../components/ui";

/**
 * A preview report its owner shared by a read-only link: the report and when it ran, nothing
 * about who ran it. Turned off, the link shows that it no longer works.
 */
export function SharedReport() {
  const { token = "" } = useParams();
  // Unlisted: whoever shared it chose who gets the link, so search engines shouldn't list it.
  usePageTitle("Shared report · Bonded", { noindex: true });
  const shared = useQuery({
    queryKey: ["shared-report", token],
    queryFn: () => byoaApi.sharedReport(token),
    retry: false,
  });
  const cta = (
    <Link to={TEST_AGENT} className={buttonClass("primary")}>
      Test your own agent, free
    </Link>
  );
  if (shared.isPending) return <Loading what="the report" height="md" />;
  if (shared.error)
    return shared.error instanceof ApiError && shared.error.status === 404 ? (
      <EmptyState title="This link doesn't work" action={cta}>
        Whoever shared it may have turned it off, or the link is incomplete.
      </EmptyState>
    ) : (
      <Unavailable error={shared.error} onRetry={() => void shared.refetch()} />
    );
  const { run, world, createdAt, label } = shared.data;
  return (
    <Page
      eyebrow="Shared report"
      title={world === "brokerage" ? "Stock-trading agent" : "Crypto-trading agent"}
      intro={`A preview rating by Bonded, shared by the person who ran it. ${label}. Ran ${new Date(createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })}.`}
      actions={cta}
    >
      {world === "brokerage" ? (
        <BrokerageFindingsReport run={run} report={brokerageReportOf(run)} />
      ) : (
        <PreviewReport run={run} />
      )}
    </Page>
  );
}
