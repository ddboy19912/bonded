import { useEffect } from "react";

/**
 * Sets the tab's title while a page is shown, and puts the old one back when it goes. With
 * `noindex`, it also asks search engines not to index the page (a shared report, say).
 */
export function usePageTitle(title: string, { noindex = false }: { noindex?: boolean } = {}) {
  useEffect(() => {
    const before = document.title;
    document.title = title;
    let robots: HTMLMetaElement | undefined;
    if (noindex) {
      robots = document.createElement("meta");
      robots.name = "robots";
      robots.content = "noindex";
      document.head.appendChild(robots);
    }
    return () => {
      document.title = before;
      robots?.remove();
    };
  }, [title, noindex]);
}
