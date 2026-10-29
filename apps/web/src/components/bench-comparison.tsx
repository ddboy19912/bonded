import { DataTable } from "./charts";
import { Card, Grid, Stat } from "./ui";
import {
  attackExecuted,
  directAskOf,
  loadBenchComparison,
  money,
  pairsOf,
  utilityOf,
  type BenchComparison,
} from "../lib/bench-comparison";

const attackName = (id: string) => id.replaceAll("_", " ");

function ComparisonTable({ row }: { row: BenchComparison }) {
  const ask = directAskOf(row.agentdojo);
  return (
    <div className="flex flex-col gap-4">
      {row.scope && <p className="text-sm text-muted">{row.scope}</p>}
      <Grid>
        <Stat
          label="Bonded, fell"
          value={`${row.bonded.fell} of ${row.bonded.countedEpisodes}`}
          hint={row.bonded.suite}
        />
        <Stat
          label="Bonded, lost"
          value={money(row.bonded.lossUsd)}
          hint={
            row.bonded.overpaidUsd > 0
              ? `${money(row.bonded.overpaidUsd)} overpaid to a real vendor`
              : "nothing overpaid to a real vendor"
          }
        />
        <Stat
          label="AgentDojo, hidden goal"
          value={`${attackExecuted(row.agentdojo)} of ${pairsOf(row.agentdojo)}`}
          hint={row.agentdojo.suite}
        />
        <Stat
          label="AgentDojo, real task done"
          value={`${utilityOf(row.agentdojo)} of ${pairsOf(row.agentdojo)}`}
          hint={
            ask.total > 0 ? `the same goal, asked outright: ${ask.done} of ${ask.total}` : undefined
          }
        />
      </Grid>
      {row.bonded.falls.length > 0 && (
        <DataTable
          head={["Bonded seed", "Briefing", "Fell", "Lost"]}
          rows={row.bonded.falls.map((fall) => [
            fall.name,
            fall.mandate === "shown" ? "rules shown" : "rules hidden",
            `${fall.fell} of ${fall.runs}`,
            money(fall.lossUsd),
          ])}
        />
      )}
      <DataTable
        head={["AgentDojo attack", "Hidden goal executed", "Real task done"]}
        rows={row.agentdojo.attacks.map((attack) => [
          attackName(attack.id),
          `${attack.attackExecuted} of ${attack.pairs}`,
          `${attack.utility} of ${attack.pairs}`,
        ])}
      />
    </div>
  );
}

/** The staged Bonded campaign beside AgentDojo, for the Index page. Not an Index score. */
export function BenchComparisonCard() {
  const data = loadBenchComparison();
  const headline = data.comparisons.find((row) => row.headline)!;
  const rest = data.comparisons.filter((row) => !row.headline);
  return (
    <Card title="Same model, two benches" description={data.disclaimer}>
      <p className="mb-4 text-sm text-soft">
        {headline.label}, recorded {data.recordedOn}. Bonded is our payment bench. AgentDojo is the
        published banking suite from ETH Zurich.
      </p>
      <ComparisonTable row={headline} />
      {headline.bonded.notes.length > 0 && (
        <ul className="mt-4 flex max-w-3xl list-disc flex-col gap-2 pl-5 text-sm text-muted">
          {headline.bonded.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
          {headline.agentdojo.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {rest.map((row) => (
        <details key={row.model} className="mt-5 border-t border-line pt-4">
          <summary className="cursor-pointer text-sm font-semibold">
            {row.label}, the smaller check
          </summary>
          <div className="mt-4">
            <ComparisonTable row={row} />
          </div>
        </details>
      ))}
    </Card>
  );
}
