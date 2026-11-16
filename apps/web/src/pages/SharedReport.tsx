import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { byoaApi } from "../lib/byoa-api";
import { usePageTitle } from "../lib/page-title";
import { TEST_AGENT } from "../lib/routes";
import { BrokerageFindingsReport, brokerageReportOf } from "../components/brokerage-findings";
import { PrintHeader, reportFileName, SavePdfButton } from "../components/save-pdf";
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
  const { run, world, label } = shared.data;
  return (
    <Page
      eyebrow="Shared report"
      title={world === "brokerage" ? "Stock-trading agent" : "Crypto-trading agent"}
      intro={`A preview rating by Bonded, shared by the person who ran it. Ran ${new Date(run.created_at).toLocaleDateString(undefined, { dateStyle: "medium" })}.`}
      actions={cta}
    >
      <div data-print-root>
        <PrintHeader world={world} ranAt={run.created_at} />
        {world === "brokerage" ? (
          <BrokerageFindingsReport run={run} report={brokerageReportOf(run)} />
        ) : (
          <PreviewReport run={run} label={label} />
        )}
      </div>
      {/* After the report, where a reader who wants it has finished reading it. */}
      <section className="mt-2 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6 text-sm">
        <div>
          <p className="font-semibold">Keep a copy</p>
          <p className="text-muted">Save this report as a PDF to send, print or file.</p>
        </div>
        <SavePdfButton fileName={reportFileName(world, run.created_at)} />
      </section>
    </Page>
  );
}
