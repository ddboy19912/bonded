import { LinkButton, MoreLink, Page } from "../components/ui";
import { TEST_AGENT } from "../lib/routes";

export function NotFound() {
  return (
    <Page
      eyebrow="404"
      title="Page not found"
      intro="There's no page at this address. Try the search at the top for an agent ID, a vault address or a transaction."
    >
      <div className="flex flex-wrap items-center gap-x-10 gap-y-6 border-t border-line pt-8">
        <LinkButton to="/overview" size="lg">
          Go to the overview
        </LinkButton>
        <MoreLink to={TEST_AGENT}>Test your agent, free</MoreLink>
        <MoreLink to="/index">See how models hold up</MoreLink>
      </div>
    </Page>
  );
}
