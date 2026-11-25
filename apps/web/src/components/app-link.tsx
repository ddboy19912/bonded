import type { ReactNode } from "react";
import { Link } from "react-router";
import { appHref, onSiteHost } from "../lib/hosts";

/**
 * A link from the public site to an app page. On www.bondedhq.xyz it is a plain link to
 * app.bondedhq.xyz; elsewhere (the app itself, local development, previews) a router link.
 */
export function AppLink(props: {
  to: string;
  className?: string;
  "aria-label"?: string;
  children: ReactNode;
}) {
  const { to, children, ...rest } = props;
  if (onSiteHost()) {
    return (
      <a href={appHref(to)} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link to={to} {...rest}>
      {children}
    </Link>
  );
}
