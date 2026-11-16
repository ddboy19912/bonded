import { Button } from "./ui";

/**
 * Saves the report on the page as a PDF, through the browser's print dialog ("Save as PDF").
 * Only the element marked `data-print-root` prints, on a light page (index.css, "Print"). The
 * page's title names the file while the dialog is open.
 */
export function SavePdfButton({
  fileName,
  size = "md",
}: {
  fileName: string;
  /** The size of the buttons beside it. */
  size?: "sm" | "md";
}) {
  const save = () => {
    const title = document.title;
    document.title = fileName;
    // Folded sections print open, then fold again.
    const folded = [
      ...document.querySelectorAll<HTMLDetailsElement>("[data-print-root] details"),
    ].filter((d) => !d.open);
    for (const d of folded) d.open = true;
    const restore = () => {
      document.title = title;
      for (const d of folded) d.open = false;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  };
  return (
    <Button kind="secondary" size={size} onClick={save}>
      Save as PDF
    </Button>
  );
}

/** The report's heading on paper: what it is, when it ran and where it came from. */
export function PrintHeader({ world, ranAt }: { world: "vault" | "brokerage"; ranAt: string }) {
  return (
    <div className="mb-8 hidden border-b border-line pb-4 print:block">
      <p className="text-lg font-bold">
        Bonded preview report: {world === "brokerage" ? "stock-trading" : "crypto-trading"} agent
      </p>
      <p className="mt-1 text-xs text-muted">
        Ran {new Date(ranAt).toLocaleDateString("en-GB", { dateStyle: "long" })} · www.bondedhq.xyz
      </p>
    </div>
  );
}

/** A report's PDF file name: "Bonded report, stock-trading agent, 16 Nov 2026". */
export function reportFileName(world: "vault" | "brokerage", ranAt: string): string {
  const day = new Date(ranAt).toLocaleDateString("en-GB", { dateStyle: "medium" });
  return `Bonded report, ${world === "brokerage" ? "stock-trading" : "crypto-trading"} agent, ${day}`;
}
