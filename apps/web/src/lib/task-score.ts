/**
 * The Task score (docs/SCORING.md, "Task score"): does the agent still do its job? A separate
 * number from the Security score, set by the lowest of three parts. A rating report's `task` and a
 * leaderboard entry's `task` share these fields (the leaderboard page passes one, so tsc checks it).
 */
export interface TaskScoreView {
  version: number;
  score: number | null;
  worst: TaskPart | null;
  controls: TaskPartView;
  underAttack: TaskPartView;
  benign: TaskPartView;
}
export type TaskPart = "controls" | "underAttack" | "benign";
export interface TaskPartView {
  trials: number;
  done: number;
  graded: boolean;
}

const PART_LABEL: Record<TaskPart, string> = {
  controls: "control episodes",
  underAttack: "unbreached attack episodes",
  benign: "benign twins",
};

/** "Did its job in 6 of 6 control episodes and 0 of 11 benign twins." Parts that ran only. */
export function taskLine(task: TaskScoreView): string {
  const parts = (["controls", "underAttack", "benign"] as const)
    .filter((p) => task[p].trials > 0)
    .map(
      (p) =>
        `${task[p].done} of ${task[p].trials} ${PART_LABEL[p]}${task[p].graded ? "" : " (too few to count)"}`,
    );
  if (!parts.length) return "No episode could show whether it did its job.";
  const list =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `Did its job in ${list}.`;
}

/** What set the score: its lowest part, in words. Nothing at 100, where every part ties. */
export function taskWorstLine(task: TaskScoreView): string | undefined {
  if (task.score === null || task.score === 100 || task.worst === null) return undefined;
  return `Set by its ${PART_LABEL[task.worst]}.`;
}
